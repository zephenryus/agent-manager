import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetError, createBudget, withBudget } from "./budget.ts";
import type { BudgetSnapshot } from "./budget.ts";
import { createFakeProvider, reply } from "./providers/fake.ts";

async function setup(extra: { dailyLimit?: number | null; prices?: { inputPerMTok: number; outputPerMTok: number } } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), "am-budget-")), "usage");
  let day = new Date(2026, 9, 28, 9, 0, 0); // local time
  const make = () =>
    createBudget({ dir, dailyLimit: extra.dailyLimit === undefined ? 100 : extra.dailyLimit, now: () => day, ...(extra.prices ? { prices: extra.prices } : {}) });
  return { dir, make, setDay: (d: Date) => (day = d) };
}

test("starts empty and ok", async () => {
  const { make } = await setup();
  const s = await make().snapshot();
  assert.equal(s.date, "2026-10-28");
  assert.equal(s.totalTokens, 0);
  assert.equal(s.state, "ok");
  assert.equal(s.limit, 100);
});

test("state moves ok -> warn at 80% -> stopped at 100%", async () => {
  const { make } = await setup();
  const b = make();
  assert.equal((await b.record({ inputTokens: 50, outputTokens: 20 }, "m")).state, "ok"); // 70
  assert.equal((await b.record({ inputTokens: 5, outputTokens: 5 }, "m")).state, "warn"); // 80
  await b.assertAvailable(); // still allowed while warning
  assert.equal((await b.record({ inputTokens: 15, outputTokens: 5 }, "m")).state, "stopped"); // 100
  await assert.rejects(() => b.assertAvailable(), BudgetError);
});

test("the error message says what to do", async () => {
  const { make } = await setup({ dailyLimit: 10 });
  const b = make();
  await b.record({ inputTokens: 10, outputTokens: 5 }, "m");
  await assert.rejects(() => b.assertAvailable(), /Daily token limit reached \(15 of 10 tokens used today\)\. Raise dailyTokenLimit/);
});

test("usage persists across instances (restart) and splits input from output", async () => {
  const { make } = await setup();
  await make().record({ inputTokens: 30, outputTokens: 10 }, "m");
  const again = await make().snapshot();
  assert.equal(again.inputTokens, 30);
  assert.equal(again.outputTokens, 10);
  assert.equal(again.totalTokens, 40);
});

test("a new day starts from zero", async () => {
  const { make, setDay } = await setup();
  const b = make();
  await b.record({ inputTokens: 100, outputTokens: 0 }, "m");
  assert.equal((await b.snapshot()).state, "stopped");
  setDay(new Date(2026, 9, 29, 0, 5, 0));
  const next = await b.snapshot();
  assert.equal(next.date, "2026-10-29");
  assert.equal(next.totalTokens, 0);
  assert.equal(next.state, "ok");
  await b.assertAvailable();
});

test("subscribers hear about every recorded call, and can unsubscribe", async () => {
  const { make } = await setup();
  const b = make();
  const seen: BudgetSnapshot[] = [];
  const off = b.subscribe((s) => seen.push(s));
  await b.record({ inputTokens: 1, outputTokens: 1 }, "m");
  off();
  await b.record({ inputTokens: 1, outputTokens: 1 }, "m");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.totalTokens, 2);
});

test("estimated cost appears only when prices are configured", async () => {
  const none = await setup();
  assert.equal((await none.make().snapshot()).estimatedCostUsd, undefined);

  const priced = await setup({ prices: { inputPerMTok: 3, outputPerMTok: 15 } });
  const b = priced.make();
  const s = await b.record({ inputTokens: 1_000_000, outputTokens: 100_000 }, "m");
  assert.ok(Math.abs((s.estimatedCostUsd ?? 0) - 4.5) < 1e-9);
});

test("concurrent records are all counted", async () => {
  const { make } = await setup({ dailyLimit: 10_000 });
  const b = make();
  await Promise.all(Array.from({ length: 20 }, () => b.record({ inputTokens: 3, outputTokens: 2 }, "m")));
  assert.equal((await b.snapshot()).totalTokens, 100);
  assert.equal((await make().snapshot()).totalTokens, 100); // and all were written to disk
});

test("a damaged ledger line is skipped", async () => {
  const { make, dir } = await setup();
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "2026-10-28.jsonl"), '{"inputTokens":10,"outputTokens":5}\n{"inputTok\n');
  assert.equal((await make().snapshot()).totalTokens, 15);
});

test("an invalid limit is rejected", async () => {
  assert.throws(() => createBudget({ dir: "x", dailyLimit: 0 }), /positive/);
  assert.throws(() => createBudget({ dir: "x", dailyLimit: Number.NaN }), /positive/);
});

test("withBudget counts each model call and blocks once the limit is reached", async () => {
  const { make } = await setup({ dailyLimit: 30 });
  const budget = make();
  const inner = createFakeProvider([reply("a"), reply("b"), reply("c")]); // each call: 10 in + 5 out
  const wrapped = withBudget(inner, budget);
  const req = { system: "s", messages: [], tools: [] };

  await wrapped.complete(req); // 15
  await wrapped.complete(req); // 30 -> stopped
  assert.equal((await budget.snapshot()).state, "stopped");
  await assert.rejects(() => wrapped.complete(req), BudgetError);
  assert.equal(inner.requests.length, 2, "the blocked call never reached the model");
  assert.equal(wrapped.id, "fake");
});

test("with no limit, usage is counted and shown but nothing ever stops or warns", async () => {
  const { make } = await setup({ dailyLimit: null });
  const budget = make();
  assert.deepEqual(await budget.snapshot(), {
    date: "2026-10-28",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    limit: null,
    fraction: null,
    state: "ok",
  });
  const snap = await budget.record({ inputTokens: 900_000_000, outputTokens: 100_000_000 }, "big");
  assert.equal(snap.totalTokens, 1_000_000_000);
  assert.equal(snap.limit, null);
  assert.equal(snap.fraction, null);
  assert.equal(snap.state, "ok");
  await budget.assertAvailable(); // does not throw
});

test("with no limit, calls always reach the model, usage persists, and prices still estimate cost", async () => {
  const prices = { inputPerMTok: 3, outputPerMTok: 15 };
  const { make } = await setup({ dailyLimit: null, prices });
  const budget = make();
  const inner = createFakeProvider(Array.from({ length: 50 }, () => reply("x", { inputTokens: 1_000_000, outputTokens: 1_000_000 })));
  const wrapped = withBudget(inner, budget);
  const req = { system: "s", messages: [], tools: [] };
  for (let i = 0; i < 50; i++) await wrapped.complete(req);
  assert.equal(inner.requests.length, 50);
  const snap = await make().snapshot(); // a fresh instance reads the ledger back
  assert.equal(snap.totalTokens, 100_000_000);
  assert.equal(snap.state, "ok");
  assert.equal(snap.estimatedCostUsd, 50 * 3 + 50 * 15);
});

test("a limit of zero or less is still rejected, and the message points to null", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "am-budget-")), "usage");
  for (const bad of [0, -5, Number.NaN, Infinity]) {
    assert.throws(() => createBudget({ dir, dailyLimit: bad }), /positive number of tokens, or null for no limit/, String(bad));
  }
});

test("the limit-reached message offers null as the way out", async () => {
  const { make } = await setup({ dailyLimit: 10 });
  const budget = make();
  await budget.record({ inputTokens: 10, outputTokens: 0 }, "x");
  await assert.rejects(() => budget.assertAvailable(), /Raise dailyTokenLimit in your config, or set it to null for no limit/);
});
