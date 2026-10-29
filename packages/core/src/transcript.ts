import { randomUUID } from "node:crypto";
import { appendLine, readLastLines } from "./files.ts";
import type { Usage } from "./types.ts";
import type { ToolActivity } from "./toolActivity.ts";

export type Suggestion = {
  agentId: string;
  reason: string;
  /** A ready-to-send message for that teammate, in the user's voice. Clicking the chip puts it in the message box. */
  message?: string;
};

export type TranscriptEntry = {
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** "user", "system", or an agent id. */
  from: string;
  text: string;
  usage?: Usage;
  suggestions?: Suggestion[];
  /** Tools the agent called while writing this reply, in order. Absent when it used none. */
  tools?: ToolActivity[];
  /** Set when the turn ran out of steps, so the reply may be unfinished. */
  stopped?: "max_steps";
};

export type EntryInput = Omit<TranscriptEntry, "id" | "ts">;

export type Clock = { now(): Date; newId(): string };

export const systemClock: Clock = { now: () => new Date(), newId: () => randomUUID() };

/** Append one entry as a JSON line and return it. */
export async function appendEntry(
  path: string,
  input: EntryInput,
  clock: Clock = systemClock,
): Promise<TranscriptEntry> {
  const entry: TranscriptEntry = { id: clock.newId(), ts: clock.now().toISOString(), ...input };
  await appendLine(path, JSON.stringify(entry));
  return entry;
}

/** Last `n` entries. A damaged line (for example half-written after a crash) is skipped, not fatal. */
export async function readTail(path: string, n: number): Promise<TranscriptEntry[]> {
  const lines = await readLastLines(path, n);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // skip damaged line
    }
  }
  return entries;
}

function isEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.ts === "string" &&
    typeof v.from === "string" &&
    typeof v.text === "string"
  );
}
