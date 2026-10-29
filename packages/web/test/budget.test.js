import assert from "node:assert/strict";
import { test } from "node:test";
import { describeBudget } from "../public/budget.js";

test("unlimited: shows usage with no limit and no warning state", () => {
  const d = describeBudget({ totalTokens: 12345, limit: null, fraction: null, state: "ok" });
  assert.equal(d.state, "unlimited");
  assert.equal(d.max, null);
  assert.match(d.text, /12,345 tokens used today, no limit/);
});

test("unlimited: includes the estimated cost when there is one", () => {
  const d = describeBudget({ totalTokens: 1000, limit: null, fraction: null, state: "ok", estimatedCostUsd: 1.5 });
  assert.match(d.text, /no limit \(about \$1\.50\)/);
});

test("limited: keeps the old wording and state", () => {
  const d = describeBudget({ totalTokens: 90, limit: 100, fraction: 0.9, state: "warn" });
  assert.equal(d.state, "warn");
  assert.equal(d.max, 100);
  assert.match(d.text, /90 of 100 tokens used today/);
  assert.match(d.text, /Running low/);
});
