import type { AgentDef } from "./agents.ts";
import { createApproval } from "./approvals.ts";
import { ITEM_STATUSES, isItemStatus, listItems } from "./board.ts";
import { FIELD_KEYS, applyChange, describeChange, validateChange } from "./changes.ts";
import type { Change, ItemFields } from "./changes.ts";
import { levelOfBoardOrThrow } from "./hierarchy.ts";
import { decide } from "./permissions.ts";
import type { Action } from "./permissions.ts";
import { systemClock } from "./transcript.ts";
import type { Clock } from "./transcript.ts";
import type { Tool } from "./types.ts";
import type { Vault } from "./vault.ts";
import { readFile } from "node:fs/promises";

export type BoardToolDeps = {
  vault: Vault;
  /** Active agents, for the permission rules. */
  agents: AgentDef[];
  /** The agent using these tools. */
  actor: string;
  /** Board used when a call leaves out `board`. */
  defaultBoard?: string;
  clock?: Clock;
};

const BOARD_PROP = {
  type: "string",
  description: "Board file, like pi.md, sprint.md or tasks/<name>.md. Leave out to use the board in focus.",
};
const WHY_PROP = { type: "string", description: "Why you are making this change, in one short sentence." };
const FIELD_PROPS = {
  owner: { type: "string", description: "Agent id who owns the work." },
  parent: { type: "string", description: "The goal this rolls up to: a PI item for sprint items, a sprint item (SP-n) for tasks." },
  done_when: { type: "string", description: "A short, checkable definition of done." },
};

/**
 * Board tools with permissions. Every change goes through decide(): allowed changes are written at once,
 * everything else becomes a pending request in the approvals inbox and the board stays as it was.
 */
export function createBoardWriteTools(deps: BoardToolDeps): Tool[] {
  const clock = deps.clock ?? systemClock;

  const resolveBoard = (input: Record<string, unknown>): string => {
    const raw = input.board ?? deps.defaultBoard;
    if (typeof raw !== "string" || raw === "") throw new Error("Say which board (for example sprint.md)");
    deps.vault.boardPath(raw); // rejects names outside the boards folder
    levelOfBoardOrThrow(raw);
    return raw;
  };

  const optionalText = (input: Record<string, unknown>, key: string): string | undefined => {
    const v = input[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`${key} must be text`);
    return v;
  };

  const readFields = (input: Record<string, unknown>): ItemFields => {
    const fields: ItemFields = {};
    for (const k of FIELD_KEYS) {
      const v = optionalText(input, k);
      if (v !== undefined) fields[k] = v;
    }
    return fields;
  };

  async function submit(board: string, action: Action, change: Change, why: string, creator?: string): Promise<string> {
    validateChange(change);
    const level = levelOfBoardOrThrow(board);
    const decision = decide({
      actor: deps.actor,
      action,
      level,
      agents: deps.agents,
      ...(creator !== undefined ? { creator } : {}),
    });
    if (decision.outcome === "deny") throw new Error(decision.reason);
    if (decision.outcome === "allow") {
      const { summary } = await applyChange({ vault: deps.vault, board, change, actor: deps.actor });
      return `${summary}.`;
    }
    const approval = await createApproval(
      deps.vault,
      { actor: deps.actor, board, level, why, change, approvers: decision.approvers, needed: decision.reason },
      clock,
    );
    return (
      `Not changed yet. ${decision.reason}. Request ${approval.id} ("${describeChange(change)}") is waiting in the ` +
      `approvals inbox for ${decision.approvers.join(", then ")}.`
    );
  }

  /** The creator of an existing item, for the permission check. */
  async function creatorOf(board: string, id: string): Promise<string | undefined> {
    const text = await readFile(deps.vault.boardPath(board), "utf8").catch((err) => {
      if ((err as { code?: string }).code === "ENOENT") throw new Error(`No board named "${board}"`);
      throw err;
    });
    const item = listItems(text).find((i) => i.id === id);
    if (!item) throw new Error(`No item ${id} on ${board}`);
    return item.fields.creator;
  }

  const idInput = (input: Record<string, unknown>): string => {
    if (typeof input.id !== "string" || input.id === "") throw new Error("id must be text like T-3");
    return input.id;
  };

  return [
    {
      name: "board_list",
      description: "List every item on a board with its id, status, title and fields (creator, owner, parent, done_when).",
      inputSchema: { type: "object", properties: { board: BOARD_PROP } },
      async run(input) {
        const board = resolveBoard(input);
        const text = await readFile(deps.vault.boardPath(board), "utf8").catch((err) => {
          if ((err as { code?: string }).code === "ENOENT") throw new Error(`No board named "${board}"`);
          throw err;
        });
        return JSON.stringify(listItems(text));
      },
    },
    {
      name: "board_add",
      description:
        "Add an item to a board. Task boards: added at once. Sprint and PI boards: becomes a request that someone " +
        "must approve. Sprint items need a PI parent; task items need a sprint parent (SP-n).",
      inputSchema: {
        type: "object",
        properties: {
          board: BOARD_PROP,
          title: { type: "string", description: "Short title, one line." },
          status: { type: "string", enum: ["proposed", "active"], description: 'Defaults to "proposed".' },
          ...FIELD_PROPS,
          why: WHY_PROP,
        },
        required: ["title"],
      },
      async run(input) {
        const board = resolveBoard(input);
        if (typeof input.title !== "string") throw new Error("title must be text");
        const status = input.status === undefined ? "proposed" : input.status;
        if (status !== "proposed" && status !== "active") throw new Error('status must be "proposed" or "active"');
        const change: Change = { kind: "add", title: input.title, status, fields: readFields(input) };
        return submit(board, "create", change, optionalText(input, "why") ?? "");
      },
    },
    {
      name: "board_edit",
      description:
        "Change an item's title, owner, parent or done_when. You can change items you created, and your reports' " +
        "items. For anyone else's, or on sprint and PI boards, this becomes a request.",
      inputSchema: {
        type: "object",
        properties: {
          board: BOARD_PROP,
          id: { type: "string", description: "The item id, e.g. T-3" },
          title: { type: "string" },
          ...FIELD_PROPS,
          why: WHY_PROP,
        },
        required: ["id"],
      },
      async run(input) {
        const board = resolveBoard(input);
        const id = idInput(input);
        const title = optionalText(input, "title");
        const change: Change = { kind: "edit", id, ...(title !== undefined ? { title } : {}), fields: readFields(input) };
        return submit(board, "edit", change, optionalText(input, "why") ?? "", await creatorOf(board, id));
      },
    },
    {
      name: "board_set_status",
      description:
        `Change the status of one item (${ITEM_STATUSES.join(", ")}). Same permission rules as board_edit. ` +
        `Use "dropped" to retire an item; items are never deleted.`,
      inputSchema: {
        type: "object",
        properties: {
          board: BOARD_PROP,
          id: { type: "string", description: "The item id, e.g. T-3" },
          status: { type: "string", enum: [...ITEM_STATUSES] },
          why: WHY_PROP,
        },
        required: ["id", "status"],
      },
      async run(input) {
        const board = resolveBoard(input);
        const id = idInput(input);
        if (!isItemStatus(input.status)) throw new Error(`status must be one of: ${ITEM_STATUSES.join(", ")}`);
        const change: Change = { kind: "set_status", id, status: input.status };
        return submit(board, "edit", change, optionalText(input, "why") ?? "", await creatorOf(board, id));
      },
    },
  ];
}
