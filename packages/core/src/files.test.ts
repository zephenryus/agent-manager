import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLine, readFirstLines, readLastLines } from "./files.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "am-files-"));
}

test("missing file reads as empty", async () => {
  const dir = await tmp();
  assert.deepEqual(await readLastLines(join(dir, "nope.md"), 5), []);
  assert.deepEqual(await readFirstLines(join(dir, "nope.md"), 5), []);
});

test("tail and head on a small file", async () => {
  const path = join(await tmp(), "a.md");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  assert.deepEqual(await readLastLines(path, 2), ["three", "four"]);
  assert.deepEqual(await readFirstLines(path, 2), ["one", "two"]);
  assert.deepEqual(await readLastLines(path, 99), ["one", "two", "three", "four"]);
  assert.deepEqual(await readFirstLines(path, 99), ["one", "two", "three", "four"]);
});

test("works without a trailing newline and with CRLF", async () => {
  const path = join(await tmp(), "a.md");
  await writeFile(path, "one\r\ntwo\r\nthree");
  assert.deepEqual(await readLastLines(path, 2), ["two", "three"]);
  assert.deepEqual(await readFirstLines(path, 2), ["one", "two"]);
});

test("tail and head are correct across many 8KB chunks", async () => {
  const path = join(await tmp(), "big.md");
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(i % 40)}`);
  await writeFile(path, `${lines.join("\n")}\n`);
  assert.deepEqual(await readLastLines(path, 7), lines.slice(-7));
  assert.deepEqual(await readLastLines(path, 1200), lines.slice(-1200));
  assert.deepEqual(await readFirstLines(path, 7), lines.slice(0, 7));
  assert.deepEqual(await readFirstLines(path, 1200), lines.slice(0, 1200));
});

test("multi-byte characters survive chunk boundaries", async () => {
  const path = join(await tmp(), "utf.md");
  const lines = Array.from({ length: 3000 }, (_, i) => `日本語 ${i} café ✓`);
  await writeFile(path, `${lines.join("\n")}\n`);
  assert.deepEqual(await readLastLines(path, 500), lines.slice(-500));
  assert.deepEqual(await readFirstLines(path, 500), lines.slice(0, 500));
});

test("appendLine creates folders and flattens newlines", async () => {
  const path = join(await tmp(), "deep", "er", "log.md");
  await appendLine(path, "first\nsecond");
  await appendLine(path, "third");
  assert.deepEqual(await readLastLines(path, 10), ["first second", "third"]);
});

test("n of zero or less returns nothing", async () => {
  const path = join(await tmp(), "a.md");
  await writeFile(path, "x\n");
  assert.deepEqual(await readLastLines(path, 0), []);
  assert.deepEqual(await readFirstLines(path, -1), []);
});
