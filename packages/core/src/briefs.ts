import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { SHARED_DIR, WORKSPACES_DIR } from "./workspaces.ts";

// Briefs are short markdown summaries the Floor manager writes into workspaces/shared/briefs/. They are
// ordinary files (agents write them with files_write); this module only lists and reads them for the UI.
// Order and dates come from the file's modified time: agents do not know today's date, so none is trusted
// from a file name.

export const BRIEFS_DIR = `${WORKSPACES_DIR}/${SHARED_DIR}/briefs`;
export const MAX_BRIEFS = 100;
const MAX_BRIEF_BYTES = 200_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*\.md$/;

export type BriefInfo = { name: string; title: string; modified: string };

/** The first "# heading", else the file name without .md. */
export function briefTitle(name: string, text: string): string {
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1]) return m[1].slice(0, 120);
    if (line.trim() !== "" && !line.startsWith("---")) break;
  }
  return name.replace(/\.md$/, "");
}

async function folder(vaultRoot: string): Promise<string | null> {
  const dir = resolve(vaultRoot, BRIEFS_DIR);
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
    const real = await realpath(dir);
    const root = await realpath(resolve(vaultRoot));
    return real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}

/** Newest first. A missing folder is an empty list, not an error. */
export async function listBriefs(vaultRoot: string): Promise<BriefInfo[]> {
  const dir = await folder(vaultRoot);
  if (!dir) return [];
  const out: BriefInfo[] = [];
  for (const entry of await readdir(dir)) {
    if (!NAME_RE.test(entry)) continue;
    try {
      const path = resolve(dir, entry);
      const st = await lstat(path);
      if (!st.isFile() || st.size > MAX_BRIEF_BYTES) continue;
      const text = await readFile(path, "utf8");
      out.push({ name: entry, title: briefTitle(entry, text), modified: st.mtime.toISOString() });
    } catch {
      // unreadable file: leave it out of the list
    }
  }
  out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : a.name.localeCompare(b.name)));
  return out.slice(0, MAX_BRIEFS);
}

/** The brief's text, or null when there is no such brief. Only plain names inside the briefs folder resolve. */
export async function readBrief(vaultRoot: string, name: string): Promise<{ name: string; title: string; modified: string; text: string } | null> {
  if (!NAME_RE.test(name)) return null;
  const dir = await folder(vaultRoot);
  if (!dir) return null;
  try {
    const path = resolve(dir, name);
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_BRIEF_BYTES) return null;
    const text = await readFile(path, "utf8");
    return { name, title: briefTitle(name, text), modified: st.mtime.toISOString(), text };
  } catch {
    return null;
  }
}
