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
  assert.equal(result.text, "Updating.\n\nDone.");
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

test("an answer written in the same step as a tool call is not lost to a short closing line", async () => {
  // Real-model behaviour seen on Bedrock: full answer + suggest_next in step 1, "I've suggested X" in step 2.
  const provider = createFakeProvider([
    callTool("c1", "board_list", {}, "Theme 1: export feels risky.\nTheme 2: people double-check by hand."),
    reply("I've suggested the Research lead as the next step."),
  ]);
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("find themes")],
    tools: createBoardTools(await boardCopy()),
  });
  assert.equal(
    result.text,
    "Theme 1: export feels risky.\nTheme 2: people double-check by hand.\n\nI've suggested the Research lead as the next step.",
  );
});

function terminalTool(name: string, run: Tool["run"] = () => "ok"): Tool {
  return { name, description: "d", inputSchema: { type: "object", properties: {} }, terminal: true, run };
}

test("a terminal tool after the answer ends the turn without another model call", async () => {
  const provider = createFakeProvider([callTool("c1", "ping", {}, "Full answer."), reply("never requested")]);
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [terminalTool("ping")] });
  assert.equal(result.text, "Full answer.");
  assert.equal(result.steps, 1);
  assert.equal(provider.requests.length, 1);
  assert.equal(result.stopped, "done");
  // History stays well-formed: assistant tool call is followed by its tool result.
  assert.deepEqual(result.produced.map((m) => m.role), ["assistant", "tool"]);
});

test("a terminal tool with no answer text does not end the turn", async () => {
  const provider = createFakeProvider([callTool("c1", "ping", {}), reply("Now the answer.")]);
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [terminalTool("ping")] });
  assert.equal(result.steps, 2);
  assert.equal(result.text, "Now the answer.");
});

test("a failing terminal tool does not end the turn", async () => {
  const provider = createFakeProvider([callTool("c1", "ping", {}, "Draft."), reply("Fixed.")]);
  const failing = terminalTool("ping", () => {
    throw new Error("nope");
  });
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [failing] });
  assert.equal(result.steps, 2);
  assert.equal(result.text, "Draft.\n\nFixed.");
});

test("a terminal tool alongside a normal tool does not end the turn", async () => {
  const provider = createFakeProvider([
    {
      text: "Checking.",
      toolCalls: [
        { id: "a", name: "ping", input: {} },
        { id: "b", name: "board_list", input: {} },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    reply("Done."),
  ]);
  const result = await runTurn({
    provider,
    system: "s",
    messages: [user("go")],
    tools: [terminalTool("ping"), ...createBoardTools(await boardCopy())],
  });
  assert.equal(result.steps, 2);
});

test("steps with no text contribute nothing to the final text", async () => {
  const provider = createFakeProvider([callTool("c1", "board_list", {}), callTool("c2", "board_list", {}), reply("Only this.")]);
  const result = await runTurn({
    provider,
    system: "sys",
    messages: [user("go")],
    tools: createBoardTools(await boardCopy()),
  });
  assert.equal(result.text, "Only this.");
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
  assert.match(toolResult.output, /Your tools are: /);
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

test("an unknown tool error lists the tools the agent does have, so a small model can recover", async () => {
  const alpha = { name: "alpha", description: "d", inputSchema: { type: "object" as const, properties: {} }, run: () => "ok" };
  const beta = { ...alpha, name: "beta" };
  const provider = createFakeProvider([callTool("c1", "files_reed", {}), reply("done")]);
  const events: TurnEvent[] = [];
  await runTurn({ provider, system: "sys", messages: [user("go")], tools: [alpha, beta], onEvent: (e) => events.push(e) });
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.equal(result.output, "Unknown tool: files_reed. Your tools are: alpha, beta");
});

test("a model that goes quiet after its tools is nudged to carry on, and the nudge is not saved", async () => {
  const noop: Tool = { name: "look", description: "d", inputSchema: { type: "object", properties: {} }, run: () => "found it" };
  const provider = createFakeProvider([
    callTool("c1", "look", {}, "I will look now."),
    reply(""), // stalls
    reply("Here is what I found."),
  ]);
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [noop] });
  assert.equal(result.stopped, "done");
  assert.equal(result.steps, 3);
  assert.equal(result.text, "I will look now.\n\nHere is what I found.");
  const sent = provider.requests[2]!.messages;
  assert.match(JSON.stringify(sent.at(-1)), /haven't written your answer/);
  assert.ok(!JSON.stringify(result.produced).includes("haven't written"), "the nudge stays out of the transcript");
  assert.ok(result.produced.every((m) => m.role !== "assistant" || m.text !== "" || m.toolCalls.length > 0), "no empty assistant message is kept");
});

test("a quiet model is nudged at most twice, then the turn ends", async () => {
  const noop: Tool = { name: "look", description: "d", inputSchema: { type: "object", properties: {} }, run: () => "ok" };
  const provider = createFakeProvider([callTool("c1", "look", {}), reply(""), reply(""), reply(""), reply("never reached")]);
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [noop], maxSteps: 10 });
  assert.equal(result.steps, 4);
  assert.equal(result.text, "");
  assert.equal(result.stopped, "done");
});

test("an empty reply with no tools used is not nudged", async () => {
  const provider = createFakeProvider([reply(""), reply("later")]);
  const result = await runTurn({ provider, system: "s", messages: [user("go")], tools: [] });
  assert.equal(result.steps, 1);
});
