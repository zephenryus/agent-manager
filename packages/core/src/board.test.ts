import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, assertLineSafe, editItem, formatItem, isItemStatus, listItems, parseItem, setItemStatus } from "./board.ts";

const BOARD = [
  "# PI board",
  "- PI-1 [active] Shorten time to insight | owner: research-lead | parent: Q4",
  "- PI-2 [proposed] Critique routine",
  "Free text line that must survive.",
].join("\n");

test("parseItem reads id, status, title and extra fields", () => {
  const item = parseItem("- PI-1 [active] Shorten time to insight | owner: research-lead | parent: Q4");
  assert.deepEqual(item, {
    id: "PI-1",
    status: "active",
    title: "Shorten time to insight",
    fields: { owner: "research-lead", parent: "Q4" },
  });
});

test("parseItem ignores non-item lines and invalid statuses", () => {
  assert.equal(parseItem("# heading"), null);
  assert.equal(parseItem("- PI-9 [bogus] nope"), null);
});

test("listItems returns only items", () => {
  assert.deepEqual(
    listItems(BOARD).map((i) => i.id),
    ["PI-1", "PI-2"],
  );
});

test("setItemStatus changes only the target line and keeps the rest", () => {
  const next = setItemStatus(BOARD, "PI-2", "active");
  assert.match(next, /- PI-2 \[active\] Critique routine/);
  assert.match(next, /- PI-1 \[active\] Shorten time to insight \| owner: research-lead \| parent: Q4/);
  assert.match(next, /Free text line that must survive\./);
});

test("setItemStatus throws for an unknown id", () => {
  assert.throws(() => setItemStatus(BOARD, "PI-404", "done"), /No board item/);
});

test("isItemStatus validates", () => {
  assert.equal(isItemStatus("done"), true);
  assert.equal(isItemStatus("finished"), false);
  assert.equal(isItemStatus(42), false);
});

test("formatItem puts known fields in a fixed order and round-trips through parseItem", () => {
  const line = formatItem({ id: "T-1", status: "active", title: "Do it", fields: { parent: "SP-1", extra: "x", owner: "a", creator: "b" } });
  assert.equal(line, "- T-1 [active] Do it | owner: a | creator: b | parent: SP-1 | extra: x");
  assert.deepEqual(parseItem(line)?.fields, { owner: "a", creator: "b", parent: "SP-1", extra: "x" });
});

test("addItem goes after the last item, or under the first heading of an empty board", () => {
  const item = { id: "PI-3", status: "proposed" as const, title: "New", fields: {} };
  const out = addItem(BOARD, item).split("\n");
  assert.equal(out[3], "- PI-3 [proposed] New");
  assert.equal(out[4], "Free text line that must survive.");
  const empty = addItem("# Board\n\n## Goals\n\n## Notes\nhi", item).split("\n");
  assert.deepEqual(empty.slice(2, 5), ["## Goals", "- PI-3 [proposed] New", ""]);
  assert.equal(addItem("", item), "- PI-3 [proposed] New\n");
  assert.throws(() => addItem(BOARD, { ...item, id: "PI-1" }), /already exists/);
});

test("addItem and editItem keep Windows line endings", () => {
  const crlf = "# B\r\n- T-1 [active] One | owner: a\r\n";
  const added = addItem(crlf, { id: "T-2", status: "proposed", title: "Two", fields: {} });
  assert.equal(added, "# B\r\n- T-1 [active] One | owner: a\r\n- T-2 [proposed] Two\r\n");
  assert.equal(editItem(crlf, "T-1", { fields: { owner: "b" } }), "# B\r\n- T-1 [active] One | owner: b\r\n");
});

test("editItem changes only the named item and merges fields", () => {
  const out = editItem(BOARD, "PI-1", { title: "Faster", fields: { owner: "synthesizer" } }).split("\n");
  assert.equal(out[1], "- PI-1 [active] Faster | owner: synthesizer | parent: Q4");
  assert.equal(out[2], "- PI-2 [proposed] Critique routine");
  assert.throws(() => editItem(BOARD, "PI-9", { title: "x" }), /No board item/);
});

test("assertLineSafe rejects separators, newlines and blanks", () => {
  assert.throws(() => assertLineSafe("title", "a | b"), /cannot contain/);
  assert.throws(() => assertLineSafe("title", "a\nb"), /single line/);
  assert.throws(() => assertLineSafe("title", "  "), /cannot be empty/);
  assert.doesNotThrow(() => assertLineSafe("title", "fine, with: colon"));
});
