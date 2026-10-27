import { readFile, writeFile } from "node:fs/promises";

// Board format (markdown, one item per line; other lines are preserved untouched):
//   - PI-1 [active] Reduce time to insight | parent: Q4 | owner: research-lead

export const ITEM_STATUSES = ["proposed", "active", "done", "dropped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type BoardItem = {
  id: string;
  status: ItemStatus;
  title: string;
  fields: Record<string, string>;
};

const ITEM_RE = /^- (\S+) \[(proposed|active|done|dropped)\] (.+)$/;

export function parseItem(line: string): BoardItem | null {
  const m = ITEM_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, id, status, rest] = m as unknown as [string, string, ItemStatus, string];
  const [title, ...extras] = rest.split(" | ");
  const fields: Record<string, string> = {};
  for (const extra of extras) {
    const i = extra.indexOf(":");
    if (i > 0) fields[extra.slice(0, i).trim()] = extra.slice(i + 1).trim();
  }
  return { id, status, title: (title ?? "").trim(), fields };
}

export function listItems(text: string): BoardItem[] {
  return text
    .split("\n")
    .map(parseItem)
    .filter((i): i is BoardItem => i !== null);
}

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === "string" && (ITEM_STATUSES as readonly string[]).includes(value);
}

/** Returns the updated board text. Throws if the item does not exist. */
export function setItemStatus(text: string, id: string, status: ItemStatus): string {
  let found = false;
  const lines = text.split("\n").map((line) => {
    const item = parseItem(line);
    if (!item || item.id !== id) return line;
    found = true;
    return line.replace(/^(- \S+ \[)(?:proposed|active|done|dropped)(\] )/, `$1${status}$2`);
  });
  if (!found) throw new Error(`No board item with id "${id}"`);
  return lines.join("\n");
}

export async function readBoard(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeBoard(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf8");
}
