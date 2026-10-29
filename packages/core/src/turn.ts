import type { Message, Provider, Tool, ToolResult, Usage } from "./types.ts";

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean };

/**
 * Said to the model (never saved in the transcript) when it used tools and then stopped without writing anything.
 * Small models do this a lot: they announce "I will read that file now", make the call, then go quiet.
 */
export const CONTINUE_NUDGE =
  "[System note] You used tools but haven't written your answer yet. Carry on now: if you still need something, call the tool. Otherwise answer using what the tools returned.";

/** How many times one turn will push a quiet model to carry on. Each push still costs a step. */
const MAX_NUDGES = 2;

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
  /**
   * All assistant text produced during the turn, in order, joined by blank lines. Models often write their
   * answer in the same step as a tool call, so keeping only the last step's text would drop real answers.
   */
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
  const texts: string[] = [];
  let steps = 0;
  let nudges = 0;
  let usedTools = false;

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

    // Used tools, then said nothing: the model stalled, not finished. Ask it to carry on (the empty step is not kept).
    if (res.toolCalls.length === 0 && res.text.trim() === "" && usedTools && nudges < MAX_NUDGES && steps < maxSteps) {
      nudges++;
      history.push({ role: "user", text: CONTINUE_NUDGE });
      continue;
    }

    const assistant: Message = { role: "assistant", text: res.text, toolCalls: res.toolCalls };
    history.push(assistant);
    produced.push(assistant);
    if (res.text.trim()) {
      texts.push(res.text.trim());
      opts.onEvent?.({ type: "text", text: res.text });
    }

    if (res.toolCalls.length === 0) {
      return { text: texts.join("\n\n"), produced, steps, usage, stopped: "done" };
    }

    usedTools = true;
    const results: ToolResult[] = [];
    for (const call of res.toolCalls) {
      opts.onEvent?.({ type: "tool_call", id: call.id, name: call.name, input: call.input });
      const result = await executeTool(toolsByName.get(call.name), [...toolsByName.keys()], call.id, call.name, call.input);
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

    // Answer already written + only terminal tools that all succeeded: nothing left to say.
    const answered = res.text.trim() !== "";
    const onlyTerminal = res.toolCalls.every((c) => toolsByName.get(c.name)?.terminal === true);
    if (answered && onlyTerminal && results.every((r) => r.isError !== true)) {
      return { text: texts.join("\n\n"), produced, steps, usage, stopped: "done" };
    }
  }

  return { text: texts.join("\n\n"), produced, steps, usage, stopped: "max_steps" };
}

async function executeTool(
  tool: Tool | undefined,
  available: string[],
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!tool) {
    const have = available.length > 0 ? available.join(", ") : "none";
    return { id, name, output: `Unknown tool: ${name}. Your tools are: ${have}`, isError: true };
  }
  try {
    return { id, name, output: await tool.run(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, name, output: `Tool failed: ${message}`, isError: true };
  }
}
