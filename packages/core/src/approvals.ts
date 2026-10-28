import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyChange, describeChange } from "./changes.ts";
import type { Change } from "./changes.ts";
import type { Level } from "./permissions.ts";
import { systemClock } from "./transcript.ts";
import type { Clock } from "./transcript.ts";
import type { Vault } from "./vault.ts";

// Approval requests are plain JSON files in <vault>/approvals, one per request, so git history shows
// who asked for what and who said yes.

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type HistoryEntry = {
  /** "user" or an agent id. */
  by: string;
  /** ISO timestamp. */
  at: string;
  action: "approve" | "reject";
  reason?: string;
};

export type Approval = {
  id: string;
  status: ApprovalStatus;
  /** ISO timestamp. */
  created: string;
  /** Agent who asked. */
  actor: string;
  /** Board name relative to the boards folder. */
  board: string;
  level: Level;
  /** The agent's own reason for the change. */
  why: string;
  /** One line a person can read: what would change. */
  summary: string;
  change: Change;
  /** Escalation chain, lowest first ("floor-manager", "user"). */
  approvers: string[];
  /** Index into `approvers` of whoever decides next. */
  stage: number;
  /** Why the system required approval. */
  needed: string;
  /** Every decision so far, oldest first. An approval that passed up the chain has an entry per step. */
  history?: HistoryEntry[];
};

export type NewApproval = Pick<Approval, "actor" | "board" | "level" | "why" | "change" | "approvers" | "needed">;

const FILE_RE = /^AP-(\d+)\.json$/;

export const approvalPath = (vault: Vault, id: string): string => {
  if (!/^AP-\d+$/.test(id)) throw new Error(`Invalid approval id "${id}"`);
  return join(vault.approvalsDir, `${id}.json`);
};

async function fileNames(vault: Vault): Promise<string[]> {
  try {
    return (await readdir(vault.approvalsDir)).filter((n) => FILE_RE.test(n));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

export async function createApproval(
  vault: Vault,
  input: NewApproval,
  clock: Clock = systemClock,
): Promise<Approval> {
  const max = (await fileNames(vault)).reduce((m, n) => Math.max(m, Number(FILE_RE.exec(n)![1])), 0);
  const approval: Approval = {
    id: `AP-${max + 1}`,
    status: "pending",
    created: clock.now().toISOString(),
    summary: describeChange(input.change),
    stage: 0,
    ...input,
  };
  await mkdir(vault.approvalsDir, { recursive: true });
  await writeFile(approvalPath(vault, approval.id), JSON.stringify(approval, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return approval;
}

export async function getApproval(vault: Vault, id: string): Promise<Approval | null> {
  try {
    return JSON.parse(await readFile(approvalPath(vault, id), "utf8")) as Approval;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/** Oldest first. A damaged file is skipped rather than hiding the rest of the inbox. */
export async function listApprovals(vault: Vault, filter: { status?: ApprovalStatus } = {}): Promise<Approval[]> {
  const out: Approval[] = [];
  const names = (await fileNames(vault)).sort((a, b) => Number(FILE_RE.exec(a)![1]) - Number(FILE_RE.exec(b)![1]));
  for (const name of names) {
    try {
      const a = JSON.parse(await readFile(join(vault.approvalsDir, name), "utf8")) as Approval;
      if (filter.status === undefined || a.status === filter.status) out.push(a);
    } catch {
      // skip damaged file
    }
  }
  return out;
}

export type ApprovalErrorCode = "not_found" | "not_pending" | "not_allowed" | "stale";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export type ResolveInput = {
  vault: Vault;
  id: string;
  decision: "approve" | "reject";
  /** "user" or an agent id. */
  by: string;
  reason?: string;
  clock?: Clock;
};

/**
 * Approve or reject a pending request.
 * - Only the approver whose turn it is may decide; the user may decide at any stage.
 * - Approving below the end of the chain passes it up one level and it stays pending.
 * - Approving at the end (or as the user) writes the change to the board. If the board has moved on so the
 *   change no longer fits (item gone, parent gone), nothing is written and the request stays pending
 *   (error "stale"), so it can be rejected.
 */
export async function resolveApproval(input: ResolveInput): Promise<Approval> {
  const { vault, id, decision, by } = input;
  const clock = input.clock ?? systemClock;
  const approval = await getApproval(vault, id);
  if (!approval) throw new ApprovalError("not_found", `No approval request ${id}`);
  if (approval.status !== "pending") throw new ApprovalError("not_pending", `${id} was already ${approval.status}`);
  const next = approval.approvers[approval.stage];
  if (by !== "user" && by !== next) {
    throw new ApprovalError("not_allowed", `${id} is waiting for ${next ?? "nobody"}, not ${by}`);
  }

  const entry: HistoryEntry = {
    by,
    at: clock.now().toISOString(),
    action: decision,
    ...(input.reason !== undefined && input.reason.trim() !== "" ? { reason: input.reason.trim() } : {}),
  };
  const updated: Approval = { ...approval, history: [...(approval.history ?? []), entry] };

  if (decision === "reject") {
    updated.status = "rejected";
  } else if (by !== "user" && approval.stage < approval.approvers.length - 1) {
    updated.stage = approval.stage + 1;
  } else {
    try {
      await applyChange({ vault, board: approval.board, change: approval.change, actor: approval.actor });
    } catch (err) {
      throw new ApprovalError("stale", `The board has changed since this was requested: ${(err as Error).message}`);
    }
    updated.status = "approved";
  }
  await writeFile(approvalPath(vault, id), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return updated;
}
