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

const FIELD_ORDER = ["owner", "creator", "parent", "done_when"];

/** One board line for an item. Known fields come first in a fixed order, then any others. */
export function formatItem(item: BoardItem): string {
  const keys = Object.keys(item.fields);
  const ordered = [...FIELD_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !FIELD_ORDER.includes(k))];
  const extras = ordered.map((k) => ` | ${k}: ${item.fields[k]}`).join("");
  return `- ${item.id} [${item.status}] ${item.title}${extras}`;
}

/** A title or field value must fit on one line and must not contain the " | " separator. */
export function assertLineSafe(label: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${label} must be a single line`);
  if (value.includes(" | ")) throw new Error(`${label} cannot contain " | "`);
  if (value.trim() === "") throw new Error(`${label} cannot be empty`);
}

/** Returns the board text with `item` added after the last item (or under the first heading). */
export function addItem(text: string, item: BoardItem): string {
  const cr = text.includes("\r\n") ? "\r" : "";
  const lines = text.split("\n");
  if (listItems(text).some((i) => i.id === item.id)) throw new Error(`Item ${item.id} already exists`);
  let at = -1;
  lines.forEach((line, i) => {
    if (parseItem(line) !== null) at = i;
  });
  if (at < 0) at = lines.findIndex((l) => l.startsWith("## "));
  const line = formatItem(item) + cr;
  if (at < 0) {
    const trimmed = text.endsWith("\n") ? text : text + (text === "" ? "" : "\n");
    return trimmed + line.replace(/\r$/, "") + "\n";
  }
  lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

export type ItemPatch = { title?: string; fields?: Record<string, string> };

/** Returns the board text with one item changed. Other lines are untouched. Throws if the item is missing. */
export function editItem(text: string, id: string, patch: ItemPatch): string {
  let found = false;
  const lines = text.split("\n").map((line) => {
    const item = parseItem(line);
    if (!item || item.id !== id) return line;
    found = true;
    const next: BoardItem = {
      ...item,
      title: patch.title ?? item.title,
      fields: { ...item.fields, ...patch.fields },
    };
    return formatItem(next) + (line.endsWith("\r") ? "\r" : "");
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
