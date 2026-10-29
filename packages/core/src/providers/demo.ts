// A pretend model for exploring the UI without credentials. It routes by keyword and gives canned,
// plausible answers. It is NOT used by tests of real behaviour; the fake provider is for that.
import type { ModelRequest, ModelResponse, Provider } from "../types.ts";

export type DemoOptions = {
  /** Pause before each answer so thinking/working states are visible. Default 900ms. */
  delayMs?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === "user") return m.text;
  }
  return "";
}

function input_(req: ModelRequest): number {
  return tokens(req.system) + req.messages.reduce((n, m) => n + tokens(JSON.stringify(m)), 0);
}

function pickAgent(text: string): string {
  const t = text.toLowerCase();
  if (/(note|theme|insight|synthes|transcript|quote)/.test(t)) return "synthesizer";
  if (/(plan|interview|research|discover|learn|question|survey)/.test(t)) return "research-lead";
  return "floor-manager";
}

const REPLIES: Record<string, string> = {
  "research-lead":
    "**One clarifying question:** is the problem something people told you, or something you noticed? " +
    "I'll plan either way.\n\n" +
    "**What we need to learn**\n- What people do before and after the step\n- A specific time it went wrong\n" +
    "- What is at stake for them\n\n" +
    "**Who to talk to:** five to eight people, mixed experience, including one who avoids the feature.\n\n" +
    "**Starter questions**\n- \"Walk me through the last time you did this.\"\n- \"Tell me about a time it didn't go as expected.\"\n\n" +
    "Keep quotes and interpretations in separate columns, then hand the notes to the Synthesizer.",
  synthesizer:
    "**Caveat:** a handful of self-reported notes is thin evidence, so treat these as leads.\n\n" +
    "## Theme 1: people work around the step\n- **Observed:** one re-checks every figure; another avoids the step.\n" +
    "- **Interpretation:** the step is not treated as finished work.\n\n" +
    "## Theme 2: failures are silent\n- **Observed:** a page dropped; a timeout nobody noticed.\n" +
    "- **Interpretation:** the pain may be \"I can't tell when it failed\".\n\n" +
    "| Question | Evidence that would settle it |\n|---|---|\n| Is the dropped page real? | Compare an export with its source |\n" +
    "| How often do timeouts happen? | Logs, plus watching one happen |",
  "floor-manager":
    "Here is where things stand. This is demo mode, so I'm working from canned replies, but the real " +
    "Floor manager would read the board in focus and tell you whether the request serves an active goal.\n\n" +
    "Who would you like to hear from? The Research lead plans discovery; the Synthesizer turns notes into themes.",
};

const SUGGESTED_MESSAGES: Record<string, string> = {
  synthesizer: "Can you pull three themes and the open questions from the interview notes in the Interviews folder?",
  "research-lead": "Given these themes, what should we ask in the next round of interviews?",
};

export function createDemoProvider(opts: DemoOptions = {}): Provider {
  const delayMs = opts.delayMs ?? 900;
  return {
    id: "demo",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      await sleep(delayMs);
      const input = tokens(req.system) + req.messages.reduce((n, m) => n + tokens(JSON.stringify(m)), 0);

      if (req.tools.some((t) => t.name === "route")) {
        const text = lastUserText(req).split("New message from the user:\n").pop() ?? "";
        const agent = pickAgent(text);
        const next = agent === "research-lead" ? "synthesizer" : agent === "synthesizer" ? "research-lead" : "";
        return {
          text: "",
          toolCalls: [
            {
              id: "demo-route",
              name: "route",
              input: {
                responders: [agent],
                reason: `Demo routing: this looks like a job for ${agent}.`,
                ...(next ? { suggestions: [{ agent_id: next, reason: "A natural next step." }] } : {}),
              },
            },
          ],
          usage: { inputTokens: input, outputTokens: 40 },
        };
      }

      const id = /Your id is "([a-z0-9-]+)"/.exec(req.system)?.[1] ?? "floor-manager";

      // For questions about notes, look in the Interviews folder first (list, then read the first file), so
      // the live tool activity in the UI has something real to show. Anything else answers straight away.
      if (id !== "floor-manager" && /(interview|note|theme)/i.test(lastUserText(req))) {
        const results = req.messages.flatMap((m) => (m.role === "tool" ? m.results : []));
        const has = (name: string) => req.tools.some((t) => t.name === name);
        const call = (name: string, input: Record<string, unknown>): ModelResponse => ({
          text: "",
          toolCalls: [{ id: `demo-${name}-${results.length}`, name, input }],
          usage: { inputTokens: input_(req), outputTokens: 12 },
        });
        if (results.length === 0 && has("files_list")) return call("files_list", { folder: "Interviews" });
        if (results.length === 1 && has("files_read")) {
          const first = /^(Interviews\/\S+\.md)/m.exec(results[0]!.output)?.[1];
          if (first) return call("files_read", { path: first });
        }
      }
      const text = REPLIES[id] ?? REPLIES["floor-manager"]!;
      const wantsSuggestion = req.tools.some((t) => t.name === "suggest_next") && id !== "floor-manager";
      const suggest = id === "research-lead" ? "synthesizer" : "research-lead";
      return {
        text,
        toolCalls: wantsSuggestion
          ? [
              {
                id: "demo-suggest",
                name: "suggest_next",
                input: { agent_id: suggest, reason: "Worth a second opinion.", message: SUGGESTED_MESSAGES[suggest] ?? "" },
              },
            ]
          : [],
        usage: { inputTokens: input, outputTokens: tokens(text) },
      };
    },
  };
}
