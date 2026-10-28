import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "./frontmatter.ts";

test("parses scalars, lists, quotes, comments and the body", () => {
  const doc = parseFrontmatter(
    [
      "---",
      "# a comment",
      "name: Floor manager",
      'role: "Orchestrator: boss"',
      "token_cap: 1200",
      "is_orchestrator: true",
      "tools: [a, b , 'c d']",
      "empty: []",
      "---",
      "",
      "Charter text.",
      "Second line.",
    ].join("\n"),
  );
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.data, {
    name: "Floor manager",
    role: "Orchestrator: boss",
    token_cap: 1200,
    is_orchestrator: true,
    tools: ["a", "b", "c d"],
    empty: [],
  });
  assert.equal(doc.body, "Charter text.\nSecond line.");
});

test("handles Windows line endings and a BOM", () => {
  const doc = parseFrontmatter("﻿---\r\nname: A\r\n---\r\nBody\r\n");
  assert.deepEqual(doc.errors, []);
  assert.equal(doc.data.name, "A");
  assert.equal(doc.body, "Body");
});

test("reports a missing or unclosed block", () => {
  assert.match(parseFrontmatter("no frontmatter").errors[0] ?? "", /must start with/);
  assert.match(parseFrontmatter("---\nname: A\n").errors[0] ?? "", /not closed/);
});

test("reports bad lines, bad keys and duplicates without throwing", () => {
  const doc = parseFrontmatter("---\njust text\nBadKey: 1\nname: A\nname: B\n---\nx");
  assert.equal(doc.errors.length, 3);
  assert.equal(doc.data.name, "A");
});

test("a colon inside a value is kept", () => {
  const doc = parseFrontmatter("---\ngoal: Ship it: carefully\n---\n");
  assert.equal(doc.data.goal, "Ship it: carefully");
});
