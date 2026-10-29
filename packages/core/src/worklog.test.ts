import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoLogText, createWorklog, createWorklogTools } from "./worklog.ts";
import type { Clock } from "./transcript.ts";
import { openVault } from "./vault.ts";

async function setup(start = Date.UTC(2026, 9, 29, 2, 32)) {
  const root = await mkdtemp(join(tmpdir(), "am-worklog-"));
  let t = start;
  const clock: Clock = { now: () => new Date(t), newId: () => "id" };
  const worklog = createWorklog(openVault(root), clock, "America/Denver");
  return { root, worklog, advance: (ms: number) => (t += ms) };
}

test("an entry is one line in today's file, stamped in the chosen zone", async () => {
  const { root, worklog } = await setup();
  const line = await worklog.add({ agent: "research-lead", text: "Summarised the interviews.", item: "t-2" });
  assert.equal(line, "- 2026-10-28 20:32 research-lead [T-2] Summarised the interviews.");
  const file = await readFile(join(root, "worklog", "2026-10-28.md"), "utf8");
  assert.equal(file, `# Work log 2026-10-28\n\n${line}\n`);
});

test("auto entries are marked, and text is flattened and clipped", async () => {
  const { worklog } = await setup();
  const line = await worklog.add({ agent: "synthesizer", text: `a\n\nb ${"x".repeat(400)}`, auto: true });
  assert.match(line, /^- 2026-10-28 20:32 synthesizer \(auto\) a b x+…$/);
  assert.ok(line.length < 340);
});

test("bad input is refused with a message the agent can use", async () => {
  const { worklog } = await setup();
  await assert.rejects(() => worklog.add({ agent: "a", text: "   " }), /Say what you did/);
  await assert.rejects(() => worklog.add({ agent: "a", text: "x", item: "two" }), /board id like T-2/);
  await assert.rejects(() => worklog.add({ agent: "../x", text: "x" }), /id/i);
});

test("read returns the newest lines oldest-first, across days, with filters", async () => {
  const { worklog, advance } = await setup();
  await worklog.add({ agent: "research-lead", text: "one", item: "T-1" });
  advance(60_000);
  await worklog.add({ agent: "synthesizer", text: "two", item: "T-2" });
  advance(24 * 3600_000);
  await worklog.add({ agent: "research-lead", text: "three", item: "T-2" });
  const all = await worklog.read();
  assert.deepEqual(all.map((l) => l.split(" ").slice(3).join(" ")), ["research-lead [T-1] one", "synthesizer [T-2] two", "research-lead [T-2] three"]);
  assert.equal((await worklog.read({ limit: 2 })).length, 2);
  assert.match((await worklog.read({ limit: 1 }))[0]!, /three/);
  assert.equal((await worklog.read({ item: "t-2" })).length, 2);
  assert.equal((await worklog.read({ agent: "synthesizer" })).length, 1);
  assert.equal((await worklog.read({ agent: "nobody" })).length, 0);
});

test("reading an empty log is not an error", async () => {
  const { worklog } = await setup();
  assert.deepEqual(await worklog.read(), []);
});

test("the tools log as the acting agent and read back", async () => {
  const { worklog } = await setup();
  const [add, read] = createWorklogTools({ worklog, actor: "research-lead" });
  assert.equal(await read!.run({}), "(nothing logged yet)");
  assert.equal(await add!.run({ text: "Wrote the themes", item: "T-2" }), "Logged.");
  assert.match(String(await read!.run({ item: "T-2" })), /research-lead \[T-2\] Wrote the themes/);
  await assert.rejects(async () => add!.run({ text: 5 }), /text must be text/);
  await assert.rejects(async () => read!.run({ limit: "ten" }), /limit must be a number/);
});

test("autoLogText keeps the first line only, shortened", () => {
  assert.equal(autoLogText("Created workspaces/shared/x.md (3 lines).\nsecond"), "Created workspaces/shared/x.md (3 lines).");
  assert.ok(autoLogText("y".repeat(300)).length <= 140);
});
