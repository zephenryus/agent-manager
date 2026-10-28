import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendLine, readFirstLines, readLastLines } from "./files.ts";
import type { Vault } from "./vault.ts";

// Each agent has two private files:
//   pinned.md  standing knowledge. Rewritable, capped. Read from the top (head).
//   log.md     append-only journal. Read from the bottom (tail).

export const PINNED_MAX_LINES = 40;
export const READ_MAX_LINES = 200;

export type NotesStore = {
  head(n: number): Promise<string[]>;
  tail(n: number): Promise<string[]>;
  append(text: string): Promise<void>;
  /** Replace the pinned file. Throws if it is over the line cap, so the agent must condense. */
  pin(text: string): Promise<void>;
};

export function createNotes(
  vault: Vault,
  agentId: string,
  now: () => Date = () => new Date(),
): NotesStore {
  const paths = vault.notes(agentId);
  return {
    async head(n) {
      return readFirstLines(paths.pinned, clamp(n));
    },
    async tail(n) {
      return readLastLines(paths.log, clamp(n));
    },
    async append(text) {
      const clean = text.trim();
      if (clean === "") throw new Error("Nothing to append");
      await appendLine(paths.log, `- ${now().toISOString()} ${clean}`);
    },
    async pin(text) {
      const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
      if (lines.length > PINNED_MAX_LINES) {
        throw new Error(
          `Pinned notes are limited to ${PINNED_MAX_LINES} lines but you sent ${lines.length}. ` +
            `Condense them (merge, drop what is stale) and try again.`,
        );
      }
      await mkdir(dirname(paths.pinned), { recursive: true });
      const tmp = `${paths.pinned}.tmp`;
      await writeFile(tmp, `${lines.join("\n")}\n`, "utf8");
      await rename(tmp, paths.pinned);
    },
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(READ_MAX_LINES, Math.floor(n)));
}

/** Whole-file read used by tests and the UI. */
export async function readWhole(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return "";
    throw err;
  }
}
