import { appendFile, lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { MAX_FILE_BYTES, READABLE_EXTENSIONS } from "./fileTools.ts";
import type { Tool } from "./types.ts";
import { assertValidId } from "./vault.ts";
import type { Vault } from "./vault.ts";

// Each agent gets "its own computer": a personal folder (workspaces/<agent-id>/) for working files, and
// there is one shared folder (workspaces/shared/) for work the team uses together. Agents read every
// workspace (through files_list / files_read) but can write only to their own folder and shared/.
// The rules live here in code, not in the prompt. Git history in the vault is the undo.

export const WORKSPACES_DIR = "workspaces";
export const SHARED_DIR = "shared";

/** Largest single write, in characters. Keeps one tool call from filling the disk or a context window. */
export const MAX_WRITE_CHARS = 100_000;
/** workspaces/<owner>/[one sub-folder/]<file>: shallow on purpose, and files_list shows everything at this depth. */
const MAX_WRITE_PARTS = 4;
const MAX_SEGMENT_CHARS = 80;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type WriteMode = "create" | "replace" | "append";
const MODES: WriteMode[] = ["create", "replace", "append"];

/** Make sure the shared folder exists, so files_list and humans see it from the start. */
export async function ensureWorkspaces(vault: Vault): Promise<void> {
  await mkdir(resolve(vault.root, WORKSPACES_DIR, SHARED_DIR), { recursive: true });
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export type WorkspaceToolOptions = {
  vault: Vault;
  /** The agent these tools belong to; decides which personal folder is writable. */
  actor: string;
};

export function createWorkspaceTools(opts: WorkspaceToolOptions): Tool[] {
  assertValidId(opts.actor);
  const mine = `${WORKSPACES_DIR}/${opts.actor}`;
  const shared = `${WORKSPACES_DIR}/${SHARED_DIR}`;

  /** Check a path as the agent wrote it and return its pieces. Throws a message the agent can act on. */
  function parse(raw: unknown): { parts: string[]; shown: string; owner: string } {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error(`Give a path like ${mine}/notes.md`);
    const shown = raw.trim().replaceAll("\\", "/");
    const parts = shown.split("/");
    if (isAbsolute(shown) || /^[A-Za-z]:/.test(shown)) {
      throw new Error(`"${raw}" is an absolute path. Paths are relative to the vault, like ${mine}/notes.md`);
    }
    if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) {
      throw new Error(`"${raw}" is not a valid path (no empty parts, "..", or names starting with a dot)`);
    }
    const owner = parts[1] ?? "";
    if (parts[0] !== WORKSPACES_DIR || (owner !== opts.actor && owner !== SHARED_DIR)) {
      throw new Error(
        `You can write only inside ${mine}/ (your own files) or ${shared}/ (the team's). ` +
          `Other folders, including other agents' workspaces, are read-only for you.`,
      );
    }
    if (parts.length < 3) throw new Error(`Name a file inside ${owner === SHARED_DIR ? shared : mine}/, like ${mine}/notes.md`);
    if (parts.length > MAX_WRITE_PARTS) {
      throw new Error(`Too deep. Use at most one sub-folder: ${WORKSPACES_DIR}/<owner>/<folder>/<file>`);
    }
    for (const seg of parts) {
      if (seg.length > MAX_SEGMENT_CHARS || !SEGMENT_RE.test(seg) || /[ .]$/.test(seg) || WINDOWS_RESERVED_RE.test(seg)) {
        throw new Error(
          `"${seg}" is not an allowed name. Use letters, digits, spaces, dots, dashes, underscores or parentheses ` +
            `(at most ${MAX_SEGMENT_CHARS} characters, not ending in a space or dot).`,
        );
      }
    }
    const ext = extname(parts[parts.length - 1]!).toLowerCase();
    if (!READABLE_EXTENSIONS.includes(ext)) {
      throw new Error(`Files must end in ${READABLE_EXTENSIONS.join(", ")} so everyone can read them back`);
    }
    return { parts, shown: parts.join("/"), owner };
  }

  /** Create the folders for a write and prove the result is inside the owner's real folder (no links out). */
  async function prepareDirectory(parts: string[]): Promise<string> {
    const dirParts = parts.slice(0, -1);
    // Refuse any existing link on the way down. Only missing folders get created, so nothing can redirect them.
    let current = opts.vault.root;
    for (const seg of dirParts) {
      current = resolve(current, seg);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error(`"${seg}" is a link, which is not allowed in a workspace`);
        if (!info.isDirectory()) throw new Error(`"${seg}" is a file, not a folder`);
      } catch (err) {
        if (isMissing(err)) break;
        throw err;
      }
    }
    const dir = resolve(opts.vault.root, ...dirParts);
    await mkdir(dir, { recursive: true });
    const realOwner = await realpath(resolve(opts.vault.root, parts[0]!, parts[1]!));
    const realDir = await realpath(dir);
    if (realDir !== realOwner && !realDir.startsWith(realOwner + sep)) {
      throw new Error(`"${parts.join("/")}" is not inside the allowed folders`);
    }
    return dir;
  }

  return [
    {
      name: "files_write",
      description:
        `Save a text file in your own workspace (${mine}/) or the team's shared folder (${shared}/). You cannot ` +
        `write anywhere else. Files end in ${READABLE_EXTENSIONS.join(", ")}; one sub-folder is allowed. ` +
        `mode "create" (default) makes a new file and refuses to overwrite; "replace" rewrites a file; ` +
        `"append" adds to the end. At most ${MAX_WRITE_CHARS.toLocaleString("en-US")} characters per call. ` +
        `Everything you save can be read by the whole team.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: `For example "${shared}/2026-10-28-interview-themes.md" or "${mine}/scratch.md"` },
          content: { type: "string", description: "The text to save." },
          mode: { type: "string", description: `"create" (default), "replace" or "append".` },
        },
        required: ["path", "content"],
      },
      async run(input) {
        const { parts, shown } = parse(input.path);
        if (typeof input.content !== "string") throw new Error("content must be text");
        if (input.content.length > MAX_WRITE_CHARS) {
          throw new Error(`content is too long (limit ${MAX_WRITE_CHARS.toLocaleString("en-US")} characters). Split it into several files or appends.`);
        }
        if (input.content.includes("\u0000")) throw new Error("content must be plain text");
        const mode = input.mode === undefined ? "create" : input.mode;
        if (typeof mode !== "string" || !MODES.includes(mode as WriteMode)) {
          throw new Error(`mode must be "create", "replace" or "append"`);
        }

        const dir = await prepareDirectory(parts);
        const target = resolve(dir, parts[parts.length - 1]!);
        let existingSize: number | undefined;
        try {
          const info = await lstat(target);
          if (info.isSymbolicLink()) throw new Error(`"${shown}" is a link, which is not allowed in a workspace`);
          if (!info.isFile()) throw new Error(`"${shown}" is a folder, not a file`);
          existingSize = info.size;
        } catch (err) {
          if (!isMissing(err)) throw err;
        }

        const text = input.content.replace(/\r\n?/g, "\n");
        const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
        if (mode === "create") {
          if (existingSize !== undefined) {
            throw new Error(`"${shown}" already exists. Use mode "replace" to rewrite it or "append" to add to it, or pick a new name.`);
          }
          await writeFile(target, body, { encoding: "utf8", flag: "wx" });
          return `Created ${shown} (${describe(body)}).`;
        }
        if (mode === "replace") {
          await writeFile(target, body, "utf8");
          return `${existingSize === undefined ? "Created" : "Replaced"} ${shown} (${describe(body)}).`;
        }
        // append
        if (existingSize !== undefined && existingSize + Buffer.byteLength(body) > MAX_FILE_BYTES) {
          throw new Error(`"${shown}" would grow past the ${MAX_FILE_BYTES / 1_000_000} MB read limit. Start a new file.`);
        }
        // Keep appended text on its own line even if the file did not end with a newline.
        const needsBreak = existingSize !== undefined && existingSize > 0 && !(await endsWithNewline(target, existingSize));
        await appendFile(target, (needsBreak ? "\n" : "") + body, "utf8");
        return `${existingSize === undefined ? "Created" : "Appended to"} ${shown} (${describe(body)} added).`;
      },
    },
  ];
}

async function endsWithNewline(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function describe(text: string): string {
  const lines = text === "" ? 0 : text.split("\n").length - 1;
  return `${lines} ${lines === 1 ? "line" : "lines"}, ${Buffer.byteLength(text)} bytes`;
}
