import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolRecord, isQuietTool, summarizeError, summarizeToolCall } from "./toolActivity.ts";

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

test("error summaries drop the wrapper, flatten lines and stay short", () => {
  assert.equal(summarizeError('Tool failed: Nothing at "a.md".\nFiles in X: b.md'), 'Nothing at "a.md". Files in X: b.md');
  assert.equal(summarizeError("Unknown tool: nope. Your tools are: a, b"), "Unknown tool: nope. Your tools are: a, b");
  const long = summarizeError("x".repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("the tool record an agent sees later names each call, its outcome and the exact error", () => {
  const record = formatToolRecord([
    { name: "files_read", summary: "Interviews/a.md", ok: true },
    { name: "files_read", summary: "Interviews/b.md", ok: false, error: 'Nothing at "Interviews/b.md".' },
    { name: "notes_head", summary: "", ok: true },
  ]);
  assert.equal(record, 'ok files_read Interviews/a.md; FAILED files_read Interviews/b.md: Nothing at "Interviews/b.md".; ok notes_head');
  const many = formatToolRecord(Array.from({ length: 11 }, () => ({ name: "files_read", summary: "x", ok: true })), "max_steps");
  assert.match(many, /and 3 more; the turn ran out of steps$/);
  assert.equal(formatToolRecord([], "max_steps"), "the turn ran out of steps");
});
