import type { AgentDef } from "./agents.ts";
import type { TranscriptEntry } from "./transcript.ts";
import type { Message } from "./types.ts";

export type FocusBoard = { name: string; text: string };

export type ContextInput = {
  agent: AgentDef;
  /** Everyone on the team (active agents). Used for the "who can I suggest" list. */
  roster: AgentDef[];
  /** Transcript tail, oldest first. The last entry should be what the agent is answering. */
  transcript: TranscriptEntry[];
  /** Head of pinned notes. */
  pinned: string[];
  /** Tail of the log. */
  logTail: string[];
  focus?: FocusBoard;
  mode: "room" | "dm";
  userName?: string;
};

export type BuiltContext = { system: string; messages: Message[] };

export function buildContext(input: ContextInput): BuiltContext {
  return {
    system: buildSystem(input),
    messages: buildMessages(input),
  };
}

function buildSystem(input: ContextInput): string {
  const { agent, roster, pinned, logTail, focus, mode } = input;
  const user = input.userName ?? "the user";
  const others = roster.filter((a) => a.id !== agent.id && a.status === "active");
  const sections: string[] = [agent.charter.trim()];

  sections.push(`## Who you are\nYou are ${agent.name}, ${agent.role}. Your id is "${agent.id}".`);

  if (others.length > 0) {
    sections.push(
      `## Your teammates\n` + others.map((a) => `- ${a.id}: ${a.name}, ${a.role}`).join("\n"),
    );
  }

  sections.push(
    mode === "room"
      ? `## Where you are\nYou are in the team room with ${user}. Teammates may reply too, so keep your answer ` +
          `short and do not repeat what others said. If another teammate should weigh in, call suggest_next ` +
          `instead of answering for them.`
      : `## Where you are\nYou are in a private chat with ${user}. Keep your answer short and useful.`,
  );

  if (pinned.length > 0) {
    sections.push(`## Your pinned notes (standing knowledge, most important first)\n${pinned.join("\n")}`);
  }
  if (logTail.length > 0) {
    sections.push(`## Your recent log (newest last)\n${logTail.join("\n")}`);
  }
  if (focus) {
    sections.push(`## Board in focus: ${focus.name}\n${focus.text.trim()}`);
  }
  return sections.join("\n\n");
}

/**
 * Transcript -> alternating user/assistant messages, as model APIs require:
 * - this agent's own past replies are "assistant"; everyone else is "user" with a speaker label
 * - consecutive same-role messages are merged
 * - the conversation starts and ends with a "user" message
 */
export function buildMessages(input: ContextInput): Message[] {
  const { agent, roster } = input;
  const user = input.userName ?? "the user";
  const nameOf = new Map(roster.map((a) => [a.id, a.name]));

  type Turn = { role: "user" | "assistant"; parts: string[] };
  const turns: Turn[] = [];
  for (const entry of input.transcript) {
    const own = entry.from === agent.id;
    const role: Turn["role"] = own ? "assistant" : "user";
    const text = own
      ? entry.text
      : entry.from === "user"
        ? `${user}: ${entry.text}`
        : entry.from === "system"
          ? `[system] ${entry.text}`
          : `[${nameOf.get(entry.from) ?? entry.from}]: ${entry.text}`;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(text);
    else turns.push({ role, parts: [text] });
  }

  if (turns.length === 0) turns.push({ role: "user", parts: [`${user} opened the chat.`] });
  if (turns[0]!.role === "assistant") turns.unshift({ role: "user", parts: ["(earlier messages omitted)"] });
  if (turns[turns.length - 1]!.role === "assistant") turns.push({ role: "user", parts: ["(your turn to respond)"] });

  return turns.map((t): Message =>
    t.role === "user"
      ? { role: "user", text: t.parts.join("\n\n") }
      : { role: "assistant", text: t.parts.join("\n\n"), toolCalls: [] },
  );
}
