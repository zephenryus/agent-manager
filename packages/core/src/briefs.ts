import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Tool } from "./types.ts";
import type { Vault } from "./vault.ts";
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

// ---- the tools agents use: brief_write builds the markdown itself, so small models only supply the parts ----

export const BRIEF_LIMITS = { title: 80, bottomLine: 300, bullets: 4, bullet: 160, details: 5 } as const;
const ITEM_ID_RE = /^[A-Za-z]{1,4}-\d{1,6}$/;

/** "SP-1" -> "sp-1.md". The file name comes from the title, so rewriting a brief with the same title updates it. */
export function briefFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  if (slug === "") throw new Error("title needs some letters or numbers");
  return `${slug}.md`;
}

function text(input: Record<string, unknown>, key: string, max: number, required: boolean): string {
  const v = input[key];
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new Error(`${key} is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${key} must be text`);
  const clean = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > max) throw new Error(`${key} is ${clean.length} characters; keep it under ${max}`);
  return clean;
}

/** A list from an array, or (small models do this) from text with one item per line or comma. */
function list(input: Record<string, unknown>, key: string, comma: boolean): string[] {
  const v = input[key];
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(comma ? /[\n,]/ : /\n/) : null;
  if (raw === null || raw.some((x) => typeof x !== "string")) throw new Error(`${key} must be a list of text`);
  return (raw as string[])
    .map((x) => x.replace(/^\s*[-*•]\s*/, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((x) => x !== "");
}

async function exists(vault: Vault, rel: string): Promise<boolean> {
  const norm = rel.replaceAll("\\", "/");
  if (isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.split("/").some((p) => p === ".." || p === "")) return false;
  try {
    await stat(resolve(vault.root, norm));
    return true;
  } catch {
    return false;
  }
}

export function createBriefTools(opts: { vault: Vault; actor: string }): Tool[] {
  const root = opts.vault.root;
  return [
    {
      name: "brief_write",
      description:
        "Save a short brief for the team (shown in the Briefs tab). Give the parts; the app builds the page. Writing a " +
        "brief with the same title again updates it. Base it only on what you have read.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: `Short title, like "SP-1" or "Interview themes" (max ${BRIEF_LIMITS.title} characters)` },
          bottom_line: { type: "string", description: `One or two sentences: where things stand (max ${BRIEF_LIMITS.bottomLine} characters)` },
          bullets: { type: "array", items: { type: "string" }, description: `Up to ${BRIEF_LIMITS.bullets} short points (max ${BRIEF_LIMITS.bullet} characters each)` },
          details: {
            type: "array",
            items: { type: "string" },
            description: `Up to ${BRIEF_LIMITS.details} vault paths that exist (like boards/tasks/x.md) or board item ids (like T-2) to open for more`,
          },
        },
        required: ["title", "bottom_line"],
      },
      async run(input) {
        const title = text(input, "title", BRIEF_LIMITS.title, true);
        const bottom = text(input, "bottom_line", BRIEF_LIMITS.bottomLine, true);
        const bullets = list(input, "bullets", false);
        if (bullets.length > BRIEF_LIMITS.bullets) throw new Error(`Give at most ${BRIEF_LIMITS.bullets} bullets, not ${bullets.length}`);
        const long = bullets.find((b) => b.length > BRIEF_LIMITS.bullet);
        if (long) throw new Error(`A bullet is ${long.length} characters; keep each under ${BRIEF_LIMITS.bullet}`);
        const details = list(input, "details", true);
        if (details.length > BRIEF_LIMITS.details) throw new Error(`Give at most ${BRIEF_LIMITS.details} details, not ${details.length}`);
        const missing: string[] = [];
        for (const d of details) if (!ITEM_ID_RE.test(d) && !(await exists(opts.vault, d))) missing.push(d);
        if (missing.length > 0) {
          throw new Error(
            `Not found in the vault: ${missing.join(", ")}. Check the real paths with files_list, or leave them out. ` +
              `Nothing was saved.`,
          );
        }

        const name = briefFileName(title);
        const dir = resolve(root, BRIEFS_DIR);
        await mkdir(dir, { recursive: true });
        const path = resolve(dir, name);
        const before = await lstat(path).catch(() => null);
        if (before && !before.isFile()) throw new Error(`${name} cannot be replaced`);
        const body =
          `# ${title}\n\n${bottom}\n` +
          (bullets.length > 0 ? `\n${bullets.map((b) => `- ${b}`).join("\n")}\n` : "") +
          (details.length > 0 ? `\nDetails: ${details.join(", ")}\n` : "");
        await writeFile(path, body, "utf8");
        return `${before ? "Updated" : "Saved"} brief "${title}" as ${BRIEFS_DIR}/${name}.`;
      },
    },
    {
      name: "brief_read",
      description:
        "Read the team's briefs. With no name, lists them (newest first, with title). With a name or title, returns that brief.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: 'A brief\'s title or file name, like "SP-1" or "sp-1.md" (optional)' } } },
      async run(input) {
        const raw = input.name;
        if (raw !== undefined && typeof raw !== "string") throw new Error("name must be text");
        if (raw === undefined || raw.trim() === "") {
          const all = await listBriefs(root);
          return all.length === 0 ? "(no briefs yet)" : all.map((b) => `${b.name}: ${b.title} (${b.modified.slice(0, 10)})`).join("\n");
        }
        const wanted = raw.trim();
        let file: string;
        try {
          file = briefFileName(wanted.replace(/\.md$/i, ""));
        } catch {
          file = wanted;
        }
        const brief = await readBrief(root, file);
        if (!brief) {
          const names = (await listBriefs(root)).map((b) => b.name);
          throw new Error(`No brief named "${raw}".${names.length > 0 ? ` Briefs: ${names.join(", ")}` : " There are no briefs yet."}`);
        }
        return brief.text;
      },
    },
  ];
}
