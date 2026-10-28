import { readFile, writeFile } from "node:fs/promises";
import { addItem, assertLineSafe, editItem, isItemStatus, listItems, setItemStatus } from "./board.ts";
import type { ItemStatus } from "./board.ts";
import { levelOfBoardOrThrow, loadBoards } from "./hierarchy.ts";
import { DEFAULT_LEVEL_CONFIG, nextId, parentProblem } from "./permissions.ts";
import type { LevelConfig } from "./permissions.ts";
import type { Vault } from "./vault.ts";

/** The fields an agent may set. `creator` is never settable: it is whoever added the item. */
export type ItemFields = { owner?: string; parent?: string; done_when?: string };

/** One board change, stored in an approval request exactly as it will be applied later. */
export type Change =
  | { kind: "add"; title: string; status: "proposed" | "active"; fields: ItemFields }
  | { kind: "edit"; id: string; title?: string; fields: ItemFields }
  | { kind: "set_status"; id: string; status: ItemStatus };

export const FIELD_KEYS = ["owner", "parent", "done_when"] as const;

export function describeChange(c: Change): string {
  const extras = (f: ItemFields) =>
    FIELD_KEYS.filter((k) => f[k] !== undefined)
      .map((k) => `${k}: ${f[k]}`)
      .join(", ");
  switch (c.kind) {
    case "add":
      return `Add ${c.status} item "${c.title}"${extras(c.fields) ? ` (${extras(c.fields)})` : ""}`;
    case "edit":
      return `Edit ${c.id}: ${[c.title !== undefined ? `title: ${c.title}` : "", extras(c.fields)].filter(Boolean).join(", ")}`;
    case "set_status":
      return `Mark ${c.id} as ${c.status}`;
  }
}

/** Throws a readable error if a change is malformed. Does not look at any board. */
export function validateChange(c: Change): void {
  if (c.kind === "add") {
    assertLineSafe("title", c.title);
    if (c.status !== "proposed" && c.status !== "active") throw new Error('New items start as "proposed" or "active"');
  } else if (c.kind === "edit") {
    if (c.title !== undefined) assertLineSafe("title", c.title);
    if (c.title === undefined && FIELD_KEYS.every((k) => c.fields[k] === undefined)) {
      throw new Error("Nothing to change: give a title, owner, parent or done_when");
    }
  } else if (!isItemStatus(c.status)) {
    throw new Error("Invalid status");
  }
  if (c.kind !== "set_status") {
    for (const k of FIELD_KEYS) if (c.fields[k] !== undefined) assertLineSafe(k, c.fields[k]!);
  }
}

export type ApplyInput = {
  vault: Vault;
  /** Board name relative to the boards folder, like "sprint.md" or "tasks/research.md". */
  board: string;
  change: Change;
  /** Who made the change; becomes the creator of an added item. */
  actor: string;
  cfg?: LevelConfig;
};

/** Writes the change to the board file. Permission checks are the caller's job. */
export async function applyChange(input: ApplyInput): Promise<{ id: string; summary: string }> {
  const { vault, board, change, actor } = input;
  const cfg = input.cfg ?? DEFAULT_LEVEL_CONFIG;
  validateChange(change);
  const level = levelOfBoardOrThrow(board);
  const path = vault.boardPath(board);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") throw new Error(`No board named "${board}"`);
    throw err;
  }

  const checkParent = async (parent: string | undefined) => {
    const problem = parentProblem(level, parent, cfg);
    if (problem) throw new Error(problem);
    if (parent === undefined || level === "pi") return;
    const known = (await loadBoards(vault)).flatMap((b) => b.items.map((i) => i.id));
    if (!known.includes(parent)) throw new Error(`Parent ${parent} does not exist`);
  };

  if (change.kind === "add") {
    await checkParent(change.fields.parent);
    const ids = (await loadBoards(vault)).flatMap((b) => b.items.map((i) => i.id));
    const id = nextId(level, ids, cfg);
    const fields: Record<string, string> = {};
    for (const k of FIELD_KEYS) if (change.fields[k] !== undefined) fields[k] = change.fields[k]!;
    fields.creator = actor;
    await writeFile(path, addItem(text, { id, status: change.status, title: change.title, fields }), "utf8");
    return { id, summary: `Added ${id} to ${board}` };
  }

  const existing = listItems(text).find((i) => i.id === change.id);
  if (!existing) throw new Error(`No item ${change.id} on ${board}`);
  if (change.kind === "set_status") {
    await writeFile(path, setItemStatus(text, change.id, change.status), "utf8");
    return { id: change.id, summary: `${change.id} is now ${change.status}` };
  }
  if (change.fields.parent !== undefined) await checkParent(change.fields.parent);
  const fields: Record<string, string> = {};
  for (const k of FIELD_KEYS) if (change.fields[k] !== undefined) fields[k] = change.fields[k]!;
  await writeFile(
    path,
    editItem(text, change.id, { ...(change.title !== undefined ? { title: change.title } : {}), fields }),
    "utf8",
  );
  return { id: change.id, summary: `Updated ${change.id} on ${board}` };
}
