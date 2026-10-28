import type { AgentDef } from "./agents.ts";

// Pure rules for the board hierarchy: who may change what, and who has to approve when they may not.
// No file access here. Board tools and the approvals inbox call these functions.

/** Highest first. A task rolls up to a sprint goal, a sprint goal rolls up to a PI goal. */
export const LEVELS = ["pi", "sprint", "task"] as const;
export type Level = (typeof LEVELS)[number];

/** ID prefixes per level. Hard-coded for now; pass a different config to any function to change them. */
export type LevelConfig = Record<Level, { prefix: string }>;

export const DEFAULT_LEVEL_CONFIG: LevelConfig = {
  pi: { prefix: "PI" },
  sprint: { prefix: "SP" },
  task: { prefix: "T" },
};

/** The level an item at `level` must point to with `parent:`. A PI goal's parent is free text (a quarter). */
export const PARENT_LEVEL: Record<Level, Level | null> = { pi: null, sprint: "pi", task: "sprint" };

/** The reserved actor for the human. Agent ids cannot be "user" because roster parsing treats it as the top. */
export const USER = "user";

function idPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
}

/** Which level an item id belongs to, or null if it matches none of the prefixes. */
export function levelOfId(id: string, cfg: LevelConfig = DEFAULT_LEVEL_CONFIG): Level | null {
  for (const level of LEVELS) if (idPattern(cfg[level].prefix).test(id)) return level;
  return null;
}

/** The next unused id for a level: one more than the highest number ever seen, so ids are never reused. */
export function nextId(level: Level, existingIds: string[], cfg: LevelConfig = DEFAULT_LEVEL_CONFIG): string {
  const re = idPattern(cfg[level].prefix);
  let max = 0;
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${cfg[level].prefix}-${max + 1}`;
}

/** A readable problem with a proposed `parent:` value, or null when it is fine. */
export function parentProblem(
  level: Level,
  parent: string | undefined,
  cfg: LevelConfig = DEFAULT_LEVEL_CONFIG,
): string | null {
  const want = PARENT_LEVEL[level];
  if (want === null) return null;
  if (parent === undefined || parent === "") {
    return `A ${level} item needs a parent ${want} item (for example ${cfg[want].prefix}-1)`;
  }
  if (levelOfId(parent, cfg) !== want) {
    return `A ${level} item's parent must be a ${want} item like ${cfg[want].prefix}-1, not "${parent}"`;
  }
  return null;
}

export type Action = "create" | "edit" | "delete";

export type Decision =
  | { outcome: "allow" }
  /** Not allowed directly. `approvers` is the escalation chain, lowest first; each approves or passes it up. */
  | { outcome: "request"; approvers: string[]; reason: string }
  | { outcome: "deny"; reason: string };

export type DecideInput = {
  /** "user" or an agent id. */
  actor: string;
  action: Action;
  /** The level of the board the item lives on. */
  level: Level;
  /** Who created the item. Leave out for "create". */
  creator?: string;
  agents: AgentDef[];
};

/** True if `boss` is above `worker`: the orchestrator is above everyone, otherwise follow reports_to upward. */
export function isSupervisor(boss: string, worker: string, agents: AgentDef[]): boolean {
  if (boss === worker) return false;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const b = byId.get(boss);
  if (b?.isOrchestrator) return byId.has(worker);
  const seen = new Set<string>();
  let cursor = byId.get(worker);
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.reportsTo === boss) return true;
    seen.add(cursor.id);
    cursor = byId.get(cursor.reportsTo);
  }
  return false;
}

/**
 * Rules (spec-v0):
 * - Kevin can do anything.
 * - PI board: every agent change is a request. Escalates Floor manager first, then Kevin. The Floor manager's own go to Kevin.
 * - Sprint board: every agent change is a request to the Floor manager. The Floor manager can change it directly.
 * - Task board: anyone can create. The creator and the creator's supervisors can edit or delete. Anyone else asks the creator.
 */
export function decide(input: DecideInput): Decision {
  const { actor, action, level, agents } = input;
  if (actor === USER) return { outcome: "allow" };

  const me = agents.find((a) => a.id === actor);
  if (!me || me.status !== "active") return { outcome: "deny", reason: `"${actor}" is not an active agent` };

  const orchestrator = agents.find((a) => a.isOrchestrator && a.status === "active");

  if (level === "pi") {
    const approvers = me.isOrchestrator || !orchestrator ? [USER] : [orchestrator.id, USER];
    return { outcome: "request", approvers, reason: "PI board changes need the user's approval" };
  }

  if (level === "sprint") {
    if (me.isOrchestrator) return { outcome: "allow" };
    if (!orchestrator) return { outcome: "request", approvers: [USER], reason: "Sprint board changes need approval" };
    return { outcome: "request", approvers: [orchestrator.id], reason: "Sprint board changes go to the Floor manager" };
  }

  // Task board.
  if (action === "create") return { outcome: "allow" };
  const creator = input.creator;
  if (creator === undefined) return { outcome: "deny", reason: "An existing item needs a creator to decide who may change it" };
  if (creator === actor) return { outcome: "allow" };
  if (isSupervisor(actor, creator, agents)) return { outcome: "allow" };
  const creatorIsKnown = creator === USER || agents.some((a) => a.id === creator && a.status === "active");
  const approver = creatorIsKnown ? creator : (orchestrator?.id ?? USER);
  return { outcome: "request", approvers: [approver], reason: `This item belongs to ${creator}` };
}
