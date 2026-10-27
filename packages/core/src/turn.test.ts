import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createBoardTools } from "./boardTools.ts";
import { callTool, createFakeProvider, reply } from "./providers/fake.ts";
import { runTurn } from "./turn.ts";
import type { TurnEvent } from "./turn.ts";
import type { Tool } from "./types.ts";

const SAMPLE = fileURLToPath(new URL("../../../sample-vault/boards/pi.md", import.meta.url));

async function boardCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "am-test-"));
  const target = join(dir, "pi.md");
  await copyFile(SAMPLE, target);
  return target;
}

const user = (text: string) => ({ role: "user" as const, text });

test("a tool call round-trips and the board file changes", async () => {
  const board = await boardCopy();
  const provider = createFakeProvider([
    callTool("c1", "board_set_status", { id: "PI-2", status: "active" }, "Updating."),
    reply("Done."),
  ]);
  const events: TurnEvent[] = [];
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("activate PI-2")],
    tools: createBoardTools(board),
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.stopped, "done");
  assert.equal(result.steps, 2);
  assert.equal(result.text, "Done.");
  assert.match(await readFile(board, "utf8"), /- PI-2 \[active\]/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["text", "tool_call", "tool_result", "text"],
  );
  // The second model call must have seen the assistant tool call and the tool result.
  const second = provider.requests[1]!;
  assert.deepEqual(
    second.messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
});

test("usage is summed across steps", async () => {
  const provider = createFakeProvider([
    callTool("c1", "board_list", {}, "", { inputTokens: 100, outputTokens: 20 }),
    reply("ok", { inputTokens: 150, outputTokens: 30 }),
  ]);
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("list")],
    tools: createBoardTools(await boardCopy()),
  });
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 50 });
});

test("an unknown tool becomes an error result, not a crash", async () => {
  const provider = createFakeProvider([callTool("c1", "make_coffee", {}), reply("sorry")]);
  const events: TurnEvent[] = [];
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("coffee")],
    tools: [],
    onEvent: (e) => events.push(e),
  });
  const toolResult = events.find((e) => e.type === "tool_result");
  assert.ok(toolResult && toolResult.type === "tool_result");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.output, /Unknown tool/);
  assert.equal(result.stopped, "done");
});

test("a tool that throws is reported to the model as an error", async () => {
  const board = await boardCopy();
  const provider = createFakeProvider([
    callTool("c1", "board_set_status", { id: "NOPE-1", status: "done" }),
    reply("That item does not exist."),
  ]);
  const events: TurnEvent[] = [];
  await runTurn({
    provider,
    system: "sys",
    messages: [user("finish NOPE-1")],
    tools: createBoardTools(board),
    onEvent: (e) => events.push(e),
  });
  const toolResult = events.find((e) => e.type === "tool_result");
  assert.ok(toolResult && toolResult.type === "tool_result");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.output, /No board item/);
});

test("invalid status is rejected by the tool", async () => {
  const board = await boardCopy();
  const tools = createBoardTools(board);
  const setStatus = tools.find((t) => t.name === "board_set_status") as Tool;
  await assert.rejects(async () => setStatus.run({ id: "PI-1", status: "finished" }), /status must be one of/);
});

test("max steps stops a runaway tool loop", async () => {
  const provider = createFakeProvider(
    Array.from({ length: 10 }, (_, i) => callTool(`c${i}`, "board_list", {})),
  );
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("loop")],
    tools: createBoardTools(await boardCopy()),
    maxSteps: 3,
  });
  assert.equal(result.stopped, "max_steps");
  assert.equal(result.steps, 3);
  assert.equal(provider.requests.length, 3);
});

test("input messages are not mutated", async () => {
  const input = [user("hi")];
  await runTurn({
    provider: createFakeProvider([reply("hello")]),
    system: "sys",
    messages: input,
    tools: [],
  });
  assert.equal(input.length, 1);
});
