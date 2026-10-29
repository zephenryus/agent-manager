import assert from "node:assert/strict";
import { test } from "node:test";
import { isQuietTool, summarizeToolCall } from "./toolActivity.ts";

test("summaries name the place and the item, never file or note contents", () => {
  assert.equal(summarizeToolCall("files_read", { path: "Interviews/interview-01.md", from_line: 5 }), "Interviews/interview-01.md");
  assert.equal(summarizeToolCall("files_list", { folder: "workspaces/shared" }), "workspaces/shared");
  assert.equal(summarizeToolCall("board_edit", { board: "pi.md", id: "PI-2", title: "x" }), "pi.md · PI-2");
  assert.equal(summarizeToolCall("board_add", { board: "tasks/a.md", title: "Plan interviews" }), "tasks/a.md · Plan interviews");
  assert.equal(summarizeToolCall("files_write", { path: "workspaces/shared/a.md", content: "SECRET BODY" }), "workspaces/shared/a.md");
  assert.equal(summarizeToolCall("notes_append", { text: "private note" }), "");
  assert.equal(summarizeToolCall("files_list", {}), "");
});

test("summaries are one clean line of limited length and ignore non-text values", () => {
  assert.equal(summarizeToolCall("files_read", { path: "a\nb\tc" }), "a b c");
  assert.equal(summarizeToolCall("files_read", { path: 42, folder: "  " }), "");
  const long = summarizeToolCall("files_read", { path: "x".repeat(300) });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("suggest_next is quiet; real work tools are not", () => {
  assert.equal(isQuietTool("suggest_next"), true);
  for (const name of ["files_read", "files_write", "board_edit", "notes_append"]) assert.equal(isQuietTool(name), false, name);
});
