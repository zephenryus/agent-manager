import assert from "node:assert/strict";
import { test } from "node:test";
import { isItemStatus, listItems, parseItem, setItemStatus } from "./board.ts";

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
