import type { Message, Provider, Tool, ToolResult, Usage } from "./types.ts";

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean };

export type TurnOptions = {
  provider: Provider;
  system: string;
  /** Prior conversation (room transcript tail, etc). Not mutated. */
  messages: Message[];
  tools: Tool[];
  /** Hard stop on model calls in one turn. Protects the token budget. */
  maxSteps?: number;
  maxOutputTokens?: number;
  onEvent?: (e: TurnEvent) => void;
};

export type TurnResult = {
  /** Final assistant text (last non-empty text produced). */
  text: string;
  /** Messages produced during this turn, in order. */
  produced: Message[];
  steps: number;
  usage: Usage;
  stopped: "done" | "max_steps";
};

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const maxSteps = opts.maxSteps ?? 6;
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  const toolSpecs = opts.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

  const history: Message[] = [...opts.messages];
  const produced: Message[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let text = "";
  let steps = 0;

  while (steps < maxSteps) {
    steps++;
    const res = await opts.provider.complete({
      system: opts.system,
      messages: history,
      tools: toolSpecs,
      maxOutputTokens: opts.maxOutputTokens,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;

    const assistant: Message = { role: "assistant", text: res.text, toolCalls: res.toolCalls };
    history.push(assistant);
    produced.push(assistant);
    if (res.text.trim()) {
      text = res.text;
      opts.onEvent?.({ type: "text", text: res.text });
    }

    if (res.toolCalls.length === 0) {
      return { text, produced, steps, usage, stopped: "done" };
    }

    const results: ToolResult[] = [];
    for (const call of res.toolCalls) {
      opts.onEvent?.({ type: "tool_call", id: call.id, name: call.name, input: call.input });
      const result = await executeTool(toolsByName.get(call.name), call.id, call.name, call.input);
      opts.onEvent?.({
        type: "tool_result",
        id: result.id,
        name: result.name,
        output: result.output,
        isError: result.isError === true,
      });
      results.push(result);
    }
    const toolMessage: Message = { role: "tool", results };
    history.push(toolMessage);
    produced.push(toolMessage);
  }

  return { text, produced, steps, usage, stopped: "max_steps" };
}

async function executeTool(
  tool: Tool | undefined,
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!tool) return { id, name, output: `Unknown tool: ${name}`, isError: true };
  try {
    return { id, name, output: await tool.run(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, name, output: `Tool failed: ${message}`, isError: true };
  }
}
