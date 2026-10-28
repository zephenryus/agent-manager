import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { listItems } from "./board.ts";
import type { BoardItem } from "./board.ts";
import { DEFAULT_LEVEL_CONFIG, PARENT_LEVEL, levelOfId } from "./permissions.ts";
import type { Level, LevelConfig } from "./permissions.ts";
import type { Vault } from "./vault.ts";

// Where boards live, and how they link up. Layout inside <vault>/boards:
//   pi.md              the PI (quarter) goals
//   sprint.md          the current sprint goals; each has `parent: PI-n`
//   tasks/<name>.md    one board per piece of work; each item has `parent: SP-n`
// Item ids are unique per level across all boards, so a parent id resolves wherever it lives.
// Item fields: creator (who made it, decides who may change it), owner, parent, done_when.

/** The level a board file holds, from its name (relative to the boards folder), or null for anything else. */
export function levelOfBoard(name: string): Level | null {
  const n = name.replaceAll("\\", "/");
  if (n === "pi.md") return "pi";
  if (n === "sprint.md") return "sprint";
  if (/^tasks\/[^/]+\.md$/.test(n)) return "task";
  return null;
}

/** Level of a board file, or a readable error when the file is not part of the hierarchy. */
export function levelOfBoardOrThrow(name: string): Level {
  const level = levelOfBoard(name);
  if (level === null) throw new Error(`"${name}" is not a PI, sprint or task board (use pi.md, sprint.md or tasks/<name>.md)`);
  return level;
}

/** Every board file name (relative to the boards folder, forward slashes), sorted: pi, sprint, then tasks. */
export async function listBoardNames(vault: Vault): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(vault.root, "boards"), { recursive: true });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const names = entries.map((e) => e.replaceAll("\\", "/")).filter((n) => n.endsWith(".md"));
  const rank = (n: string) => (n === "pi.md" ? 0 : n === "sprint.md" ? 1 : n.startsWith("tasks/") ? 2 : 3);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type LoadedBoard = {
  name: string;
  /** null for a board file that is not part of the hierarchy. */
  level: Level | null;
  /** The first "# " heading, or the file name. */
  title: string;
  items: BoardItem[];
};

export function parseBoard(name: string, text: string): LoadedBoard {
  const heading = text.split("\n").find((l) => l.startsWith("# "));
  return {
    name,
    level: levelOfBoard(name),
    title: heading ? heading.slice(2).trim() : name.replace(/\.md$/, ""),
    items: listItems(text),
  };
}

export async function loadBoards(vault: Vault): Promise<LoadedBoard[]> {
  const boards: LoadedBoard[] = [];
  for (const name of await listBoardNames(vault)) {
    boards.push(parseBoard(name, await readFile(vault.boardPath(name), "utf8")));
  }
  return boards;
}

export type HierarchyIssue = {
  board: string;
  itemId: string;
  kind: "wrong_board" | "duplicate_id" | "missing_parent" | "bad_parent" | "unknown_parent" | "closed_parent";
  message: string;
};

/**
 * Problems across all boards. "Orphans" are items whose parent link is missing, wrong, unknown or already
 * closed while the item is still open. Reported, never fixed automatically.
 */
export function checkHierarchy(boards: LoadedBoard[], cfg: LevelConfig = DEFAULT_LEVEL_CONFIG): HierarchyIssue[] {
  const issues: HierarchyIssue[] = [];
  const byId = new Map<string, { board: string; item: BoardItem }>();

  for (const board of boards) {
    for (const item of board.items) {
      const here = { board: board.name, itemId: item.id };
      const itemLevel = levelOfId(item.id, cfg);
      if (board.level !== null && itemLevel !== board.level) {
        issues.push({ ...here, kind: "wrong_board", message: `${item.id} does not belong on a ${board.level} board` });
      }
      const seen = byId.get(item.id);
      if (seen) {
        issues.push({ ...here, kind: "duplicate_id", message: `${item.id} is also on ${seen.board}` });
      } else {
        byId.set(item.id, { board: board.name, item });
      }
    }
  }

  for (const board of boards) {
    for (const item of board.items) {
      const level = levelOfId(item.id, cfg);
      const wantParent = level === null ? null : PARENT_LEVEL[level];
      if (wantParent === null) continue;
      const here = { board: board.name, itemId: item.id };
      const parent = item.fields.parent;
      if (parent === undefined || parent === "") {
        issues.push({ ...here, kind: "missing_parent", message: `${item.id} has no parent (expected a ${wantParent} item)` });
      } else if (levelOfId(parent, cfg) !== wantParent) {
        issues.push({ ...here, kind: "bad_parent", message: `${item.id}'s parent "${parent}" is not a ${wantParent} item` });
      } else {
        const found = byId.get(parent);
        if (!found) {
          issues.push({ ...here, kind: "unknown_parent", message: `${item.id}'s parent ${parent} does not exist` });
        } else if (
          (found.item.status === "done" || found.item.status === "dropped") &&
          (item.status === "proposed" || item.status === "active")
        ) {
          issues.push({
            ...here,
            kind: "closed_parent",
            message: `${item.id} is ${item.status} but its parent ${parent} is ${found.item.status}`,
          });
        }
      }
    }
  }
  return issues;
}

/** The chain from an item up to its top-level goal, nearest first. Stops at a missing or looping link. */
export function ancestors(boards: LoadedBoard[], id: string): BoardItem[] {
  const items = new Map(boards.flatMap((b) => b.items.map((i) => [i.id, i] as const)));
  const chain: BoardItem[] = [];
  const seen = new Set<string>([id]);
  let cursor = items.get(id);
  while (cursor) {
    const parentId = cursor.fields.parent;
    const parent = parentId === undefined ? undefined : items.get(parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}
