// What an agent did with tools during a turn, in a form that is safe to store and show. Only a short
// label is kept (a path, a board, an item id or title). Never file contents or note text: transcripts are
// saved in the vault and shown to the user, and the point is "did it run, and on what", not a full log.

export type ToolActivity = {
  name: string;
  /** Short label such as "Interviews/interview-01.md". May be empty. */
  summary: string;
  ok: boolean;
  /** Why it failed, in one short line. Only set when ok is false. */
  error?: string;
};

const MAX_SUMMARY = 80;

/** Tools whose effect is already visible elsewhere (suggest_next shows up as a chip), so they stay out of the trace. */
export function isQuietTool(name: string): boolean {
  return name === "suggest_next";
}

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned === "" ? undefined : cleaned;
}

/** A one-line label for a tool call, built from an allow-list of harmless fields. */
export function summarizeToolCall(_name: string, input: Record<string, unknown>): string {
  const where = text(input.path) ?? text(input.folder) ?? text(input.board);
  const what = text(input.id) ?? text(input.title);
  const label = [where, what].filter((x): x is string => x !== undefined).join(" · ");
  return label.length > MAX_SUMMARY ? `${label.slice(0, MAX_SUMMARY - 1)}…` : label;
}

const MAX_ERROR = 200;
const MAX_RECORDED = 8;

/** The reason a tool failed, as one short line: the tool's own message, without the "Tool failed:" wrapper. */
export function summarizeError(output: string): string {
  const line = output
    .replace(/^Tool failed:\s*/, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR - 1)}…` : line;
}

/**
 * A compact record of an agent's own tool calls, for the agent to see in later turns. Models only keep their
 * reply text between turns, so without this "what was the error?" has no answer.
 */
export function formatToolRecord(tools: ToolActivity[], stopped?: "max_steps"): string {
  const shown = tools.slice(0, MAX_RECORDED).map((t) => {
    const what = `${t.name}${t.summary ? ` ${t.summary}` : ""}`;
    return t.ok ? `ok ${what}` : `FAILED ${what}${t.error ? `: ${t.error}` : ""}`;
  });
  if (tools.length > MAX_RECORDED) shown.push(`and ${tools.length - MAX_RECORDED} more`);
  if (stopped) shown.push("the turn ran out of steps");
  return shown.join("; ");
}
