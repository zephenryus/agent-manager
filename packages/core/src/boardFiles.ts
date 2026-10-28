import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Level } from "./permissions.ts";
import { levelOfBoard } from "./hierarchy.ts";
import type { Vault } from "./vault.ts";

/** Names an agent may create: tasks/<lowercase-name>.md. PI and sprint boards are made by setup, never by agents. */
export const NEW_BOARD_RE = /^tasks\/[a-z0-9][a-z0-9-]*\.md$/;

const SECTION: Record<Level, string> = { pi: "Goals", sprint: "Goals", task: "Tasks" };

/** The text of an empty board: a heading and the section items go under. */
export function blankBoard(name: string): string {
  const level = levelOfBoard(name);
  if (level === null) throw new Error(`"${name}" is not a PI, sprint or task board`);
  const base = name.replaceAll("\\", "/").split("/").pop()!.replace(/\.md$/, "");
  const title =
    level === "pi"
      ? "PI board"
      : level === "sprint"
        ? "Sprint board"
        : base.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
  return `# ${title}\n\n## ${SECTION[level]}\n`;
}

/** Writes an empty board unless one is already there. Returns true when it created the file. */
export async function ensureBoard(vault: Vault, name: string): Promise<boolean> {
  const path = vault.boardPath(name);
  try {
    await readFile(path, "utf8");
    return false;
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, blankBoard(name), { encoding: "utf8", flag: "wx" });
  return true;
}

/**
 * Makes sure a vault has the boards the app expects: pi.md, sprint.md and a tasks/ folder.
 * Existing files are never touched. Returns the names it created.
 */
export async function ensureBoardFiles(vault: Vault): Promise<string[]> {
  const made: string[] = [];
  for (const name of ["pi.md", "sprint.md"]) if (await ensureBoard(vault, name)) made.push(name);
  await mkdir(join(vault.root, "boards", "tasks"), { recursive: true });
  return made;
}
