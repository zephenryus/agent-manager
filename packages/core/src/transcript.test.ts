import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEntry, readTail } from "./transcript.ts";
import type { Clock } from "./transcript.ts";

function fakeClock(): Clock {
  let n = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 27, 20, 0, n++)), newId: () => `id-${n}` };
}

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "am-tr-")), "rooms", "main.jsonl");
}

test("append then read the tail, oldest first", async () => {
  const path = await file();
  const clock = fakeClock();
  for (let i = 0; i < 5; i++) await appendEntry(path, { from: "user", text: `m${i}` }, clock);
  const tail = await readTail(path, 3);
  assert.deepEqual(tail.map((e) => e.text), ["m2", "m3", "m4"]);
  assert.match(tail[0]!.ts, /^2026-10-27T20:00:0\d\.000Z$/);
});

test("optional fields round-trip", async () => {
  const path = await file();
  await appendEntry(
    path,
    {
      from: "research-lead",
      text: "hi",
      usage: { inputTokens: 5, outputTokens: 2 },
      suggestions: [{ agentId: "synthesizer", reason: "has notes" }],
    },
    fakeClock(),
  );
  const [entry] = await readTail(path, 1);
  assert.deepEqual(entry?.usage, { inputTokens: 5, outputTokens: 2 });
  assert.deepEqual(entry?.suggestions, [{ agentId: "synthesizer", reason: "has notes" }]);
});

test("a damaged or foreign line is skipped, not fatal", async () => {
  const path = await file();
  const clock = fakeClock();
  await appendEntry(path, { from: "user", text: "good 1" }, clock);
  await appendFile(path, '{"id":"x","ts":"t","from":"user","tex\n');
  await appendFile(path, '{"unrelated":true}\n');
  await appendEntry(path, { from: "user", text: "good 2" }, clock);
  assert.deepEqual((await readTail(path, 10)).map((e) => e.text), ["good 1", "good 2"]);
});

test("a missing transcript is empty", async () => {
  assert.deepEqual(await readTail(await file(), 5), []);
});

test("newlines inside text survive the JSON line", async () => {
  const path = await file();
  await appendEntry(path, { from: "user", text: "a\nb" }, fakeClock());
  assert.equal((await readTail(path, 1))[0]?.text, "a\nb");
});
