import { PINNED_MAX_LINES, READ_MAX_LINES } from "./notes.ts";
import type { NotesStore } from "./notes.ts";
import type { Tool } from "./types.ts";

function lineCount(input: Record<string, unknown>, fallback: number): number {
  const v = input.lines;
  if (v === undefined) return fallback;
  if (typeof v !== "number") throw new Error("lines must be a number");
  return v;
}

/** The four memory tools from the spec. Every tool returns plain text the model can read. */
export function createNotesTools(notes: NotesStore): Tool[] {
  return [
    {
      name: "notes_head",
      description:
        `Read the first N lines of your pinned notes (your standing knowledge). ` +
        `Default 20, max ${READ_MAX_LINES}. The most important facts are kept at the top.`,
      inputSchema: {
        type: "object",
        properties: { lines: { type: "number", description: "How many lines to read from the top" } },
      },
      async run(input) {
        const lines = await notes.head(lineCount(input, 20));
        return lines.length === 0 ? "(pinned notes are empty)" : lines.join("\n");
      },
    },
    {
      name: "notes_tail",
      description:
        `Read the last N lines of your log (newest entries are at the bottom). ` +
        `Default 20, max ${READ_MAX_LINES}.`,
      inputSchema: {
        type: "object",
        properties: { lines: { type: "number", description: "How many lines to read from the bottom" } },
      },
      async run(input) {
        const lines = await notes.tail(lineCount(input, 20));
        return lines.length === 0 ? "(log is empty)" : lines.join("\n");
      },
    },
    {
      name: "notes_append",
      description:
        "Add one entry to your log: something you learned, decided or want to remember. Keep it to one or two sentences.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async run(input) {
        if (typeof input.text !== "string") throw new Error("text must be a string");
        await notes.append(input.text);
        return "Logged.";
      },
    },
    {
      name: "notes_pin",
      description:
        `Replace your pinned notes with a new version (max ${PINNED_MAX_LINES} lines). ` +
        `Put the most important standing knowledge first. This overwrites the previous pinned notes, ` +
        `so include everything you want to keep.`,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The complete new pinned notes" } },
        required: ["text"],
      },
      async run(input) {
        if (typeof input.text !== "string") throw new Error("text must be a string");
        await notes.pin(input.text);
        return "Pinned notes updated.";
      },
    },
  ];
}
