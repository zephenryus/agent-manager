import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PINNED_MAX_LINES, createNotes, readWhole } from "./notes.ts";
import { createNotesTools } from "./notesTools.ts";
import { openVault } from "./vault.ts";

async function setup() {
  const vault = openVault(await mkdtemp(join(tmpdir(), "am-notes-")));
  let tick = 0;
  const notes = createNotes(vault, "research-lead", () => new Date(Date.UTC(2026, 9, 27, 20, 0, tick++)));
  const tools = Object.fromEntries(createNotesTools(notes).map((t) => [t.name, t]));
  return { vault, notes, tools };
}

test("empty notes read as empty", async () => {
  const { notes } = await setup();
  assert.deepEqual(await notes.head(10), []);
  assert.deepEqual(await notes.tail(10), []);
});

test("log is append-only and read from the tail", async () => {
  const { notes } = await setup();
  for (let i = 0; i < 30; i++) await notes.append(`fact ${i}`);
  const tail = await notes.tail(3);
  assert.equal(tail.length, 3);
  assert.match(tail[2]!, /^- 2026-10-27T20:00:29\.000Z fact 29$/);
  assert.match(tail[0]!, /fact 27$/);
});

test("pin replaces the pinned file and head reads the top", async () => {
  const { notes, vault } = await setup();
  await notes.pin("Most important\nSecond\nThird");
  assert.deepEqual(await notes.head(2), ["Most important", "Second"]);
  await notes.pin("Replaced");
  assert.deepEqual(await notes.head(10), ["Replaced"]);
  assert.equal(await readWhole(vault.notes("research-lead").pinned), "Replaced\n");
});

test("pin refuses text over the cap and leaves the old notes alone", async () => {
  const { notes } = await setup();
  await notes.pin("keep me");
  const tooLong = Array.from({ length: PINNED_MAX_LINES + 1 }, (_, i) => `l${i}`).join("\n");
  await assert.rejects(() => notes.pin(tooLong), /limited to 40 lines/);
  assert.deepEqual(await notes.head(10), ["keep me"]);
});

test("append rejects empty text", async () => {
  const { notes } = await setup();
  await assert.rejects(() => notes.append("   "), /Nothing to append/);
});

test("read sizes are clamped", async () => {
  const { notes } = await setup();
  for (let i = 0; i < 300; i++) await notes.append(`n${i}`);
  assert.equal((await notes.tail(100000)).length, 200);
  assert.equal((await notes.tail(-4)).length, 1);
});

test("tools return readable text", async () => {
  const { tools } = await setup();
  assert.equal(await tools.notes_head!.run({}), "(pinned notes are empty)");
  assert.equal(await tools.notes_tail!.run({}), "(log is empty)");
  assert.equal(await tools.notes_append!.run({ text: "learned x" }), "Logged.");
  assert.match(await tools.notes_tail!.run({ lines: 5 }), /learned x$/);
  assert.equal(await tools.notes_pin!.run({ text: "standing fact" }), "Pinned notes updated.");
  assert.equal(await tools.notes_head!.run({ lines: 5 }), "standing fact");
});

test("tools validate their input", async () => {
  const { tools } = await setup();
  await assert.rejects(async () => tools.notes_append!.run({ text: 5 }), /text must be a string/);
  await assert.rejects(async () => tools.notes_head!.run({ lines: "ten" }), /lines must be a number/);
});

test("agent ids cannot escape the notes folder", async () => {
  const vault = openVault(await mkdtemp(join(tmpdir(), "am-notes-")));
  assert.throws(() => vault.notes("../evil"), /Invalid id/);
  assert.throws(() => vault.dmFile("a/b"), /Invalid id/);
});
