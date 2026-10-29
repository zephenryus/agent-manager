import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { systemClock } from "./transcript.ts";
import type { Clock } from "./transcript.ts";
import type { Tool } from "./types.ts";
import { assertValidId } from "./vault.ts";
import type { Vault } from "./vault.ts";

// The team's shared work log: one line per piece of work, in plain markdown files (worklog/YYYY-MM-DD.md),
// so the Floor manager can see what has been done without having read every file. Two kinds of lines:
//   - written by the app after a turn that changed something (files saved, board edits), marked "(auto)";
//   - written by an agent with worklog_add, saying what it did and why in a sentence.
//
//   - 2026-10-28 20:32 research-lead [T-2] Summarised the five interviews into themes.
//   - 2026-10-28 20:33 research-lead (auto) Created workspaces/shared/themes.md (12 lines, 480 bytes).

export const WORKLOG_DIR = "worklog";
export const MAX_ENTRY_CHARS = 300;
export const READ_DEFAULT = 20;
export const READ_MAX = 50;
const ITEM_RE = /^[A-Za-z]{1,4}-\d{1,6}$/;
const LINE_RE = /^- (\d{4}-\d\d-\d\d \d\d:\d\d) ([a-z0-9][a-z0-9-]*)(?: \[([^\]]+)\])?(?: \((auto)\))? (.*)$/;
const MAX_DAYS_SCANNED = 14;

export type WorklogEntry = { agent: string; text: string; item?: string; auto?: boolean };

export type Worklog = {
  add(entry: WorklogEntry): Promise<string>;
  /** Newest `limit` matching lines, oldest first. */
  read(opts?: { limit?: number; agent?: string; item?: string }): Promise<string[]>;
};

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** "2026-10-28" and "20:32" in the given zone (default: this computer's). */
function stamp(now: Date, timeZone?: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export function createWorklog(vault: Vault, clock: Clock = systemClock, timeZone?: string): Worklog {
  const dir = resolve(vault.root, WORKLOG_DIR);

  return {
    async add(entry) {
      assertValidId(entry.agent);
      const text = oneLine(entry.text);
      if (text === "") throw new Error("Say what you did in a sentence.");
      const clipped = text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS - 1)}…` : text;
      let item = "";
      if (entry.item !== undefined && entry.item.trim() !== "") {
        const id = entry.item.trim().toUpperCase();
        if (!ITEM_RE.test(id)) throw new Error(`item must be a board id like T-2, not "${entry.item}"`);
        item = ` [${id}]`;
      }
      const { day, time } = stamp(clock.now(), timeZone);
      const line = `- ${day} ${time} ${entry.agent}${item}${entry.auto ? " (auto)" : ""} ${clipped}`;
      await mkdir(dir, { recursive: true });
      const file = resolve(dir, `${day}.md`);
      const exists = await stat(file).then(() => true, (err) => (isMissing(err) ? false : Promise.reject(err)));
      await appendFile(file, `${exists ? "" : `# Work log ${day}\n\n`}${line}\n`, "utf8");
      return line;
    },

    async read(opts = {}) {
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? READ_DEFAULT), 1), READ_MAX);
      const item = opts.item?.trim().toUpperCase();
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().reverse();
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
      const newestFirst: string[] = [];
      for (const f of files.slice(0, MAX_DAYS_SCANNED)) {
        const lines = (await readFile(resolve(dir, f), "utf8")).split(/\r?\n/).filter((l) => l.startsWith("- "));
        for (const l of lines.reverse()) {
          const m = LINE_RE.exec(l);
          if (!m) continue;
          if (opts.agent && m[2] !== opts.agent) continue;
          if (item && m[3]?.toUpperCase() !== item) continue;
          newestFirst.push(l);
          if (newestFirst.length >= limit) return newestFirst.reverse();
        }
      }
      return newestFirst.reverse();
    },
  };
}

/** The tools whose results are recorded automatically in the log, because they change something. */
export const LOGGED_TOOLS = ["files_write", "board_add", "board_edit", "board_set_status", "brief_write"];

/** The first line of a tool's result, shortened. These results are written by the app, not by the model. */
export function autoLogText(output: string): string {
  const first = oneLine(output.split("\n")[0] ?? "");
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

export function createWorklogTools(opts: { worklog: Worklog; actor: string }): Tool[] {
  return [
    {
      name: "worklog_add",
      description:
        "Add one line to the team's shared work log: what you did and where the result is. Do this when you finish a " +
        "piece of work (a file saved, a board change, a finding). Include the board item id if it is about one.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: `One or two sentences, up to ${MAX_ENTRY_CHARS} characters` },
          item: { type: "string", description: "Board item id this is about, like T-2 (optional)" },
        },
        required: ["text"],
      },
      async run(input) {
        if (typeof input.text !== "string") throw new Error("text must be text");
        if (input.item !== undefined && typeof input.item !== "string") throw new Error("item must be text like T-2");
        await opts.worklog.add({ agent: opts.actor, text: input.text, ...(input.item ? { item: input.item as string } : {}) });
        return "Logged.";
      },
    },
    {
      name: "worklog_read",
      description:
        `Read the team's shared work log: what each teammate has done recently, newest last. Default ${READ_DEFAULT} ` +
        `lines, max ${READ_MAX}. Filter by teammate id or board item id.`,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many recent lines" },
          agent: { type: "string", description: "Only this teammate's id (optional)" },
          item: { type: "string", description: "Only this board item, like T-2 (optional)" },
        },
      },
      async run(input) {
        const num = input.limit;
        if (num !== undefined && typeof num !== "number") throw new Error("limit must be a number");
        const lines = await opts.worklog.read({
          ...(num !== undefined ? { limit: num } : {}),
          ...(typeof input.agent === "string" && input.agent ? { agent: input.agent } : {}),
          ...(typeof input.item === "string" && input.item ? { item: input.item } : {}),
        });
        return lines.length === 0 ? "(nothing logged yet)" : lines.join("\n");
      },
    },
  ];
}
