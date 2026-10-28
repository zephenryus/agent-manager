// Minimal frontmatter parser for agent files. Deliberately a small, documented subset of YAML so the
// core has no dependencies:
//   key: value            string (optionally in "double" or 'single' quotes), number, true/false
//   key: [a, b, c]        inline list of strings
//   # comment             ignored
// Nested maps and multi-line values are NOT supported.

export type FrontmatterValue = string | number | boolean | string[];

export type ParsedDocument = {
  data: Record<string, FrontmatterValue>;
  body: string;
  /** Problems found while parsing (never thrown; the caller decides what is fatal). */
  errors: string[];
};

export function parseFrontmatter(source: string): ParsedDocument {
  // Normalize BOM and Windows line endings so files edited on either OS parse the same.
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const errors: string[] = [];

  if (!text.startsWith("---\n")) {
    return { data: {}, body: text, errors: ["File must start with a --- frontmatter block"] };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: "", errors: ["Frontmatter block is not closed with ---"] };
  }
  const header = text.slice(4, end);
  const afterClose = text.indexOf("\n", end + 1);
  const body = afterClose === -1 ? "" : text.slice(afterClose + 1);

  const data: Record<string, FrontmatterValue> = {};
  header.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      errors.push(`Line ${index + 2}: expected "key: value"`);
      return;
    }
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      errors.push(`Line ${index + 2}: invalid key "${key}" (use lower_snake_case)`);
      return;
    }
    if (key in data) {
      errors.push(`Line ${index + 2}: duplicate key "${key}"`);
      return;
    }
    data[key] = parseValue(raw);
  });

  return { data, body: body.trim(), errors };
}

function parseValue(raw: string): FrontmatterValue {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => unquote(part.trim()));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return unquote(raw);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}
