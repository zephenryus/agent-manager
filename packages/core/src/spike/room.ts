// Live spike: the whole room against Bedrock. Real router (router model) + real agents (specialist model).
// Needs config.local.json at the repo root and fresh AWS credentials. Uses a temp vault; nothing in the repo changes.
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_TOOLS, createRoom } from "../room.ts";
import type { RoomEvent, SendResult } from "../room.ts";
import { loadAgents } from "../agents.ts";
import { createBedrockProvider } from "../providers/bedrock.ts";
import { createLlmRouter } from "../router.ts";
import { ProviderAuthError } from "../types.ts";
import { openVault } from "../vault.ts";
import { repoRoot } from "./shared.ts";

type Config = {
  aws: { profile: string; region: string };
  models: { router: string; specialist: string };
};

const config = JSON.parse(await readFile(join(repoRoot, "config.local.json"), "utf8")) as Config;
const sample = join(repoRoot, "sample-vault");

// A scratch vault: sample boards copied in, agents loaded straight from the sample folder.
const vault = openVault(await mkdtemp(join(tmpdir(), "am-room-spike-")));
await mkdir(join(vault.root, "boards"), { recursive: true });
await cp(join(sample, "boards"), join(vault.root, "boards"), { recursive: true });

const { agents, issues } = await loadAgents(join(sample, "agents"), [...KNOWN_TOOLS]);
for (const issue of issues) console.log(`  [roster ${issue.level}] ${issue.agentId ?? ""} ${issue.message}`);

const make = (modelId: string) =>
  createBedrockProvider({ profile: config.aws.profile, region: config.aws.region, modelId });
const routerProvider = make(config.models.router);
const specialist = make(config.models.specialist);

function show(e: RoomEvent): void {
  if (e.type === "routing") {
    const d = e.decision;
    console.log(`  [routing:${d.source}] -> ${d.responders.join(", ")} (${d.reason})`);
  } else if (e.type === "agent_state") {
    console.log(`  [${e.agentId}] ${e.state}`);
  } else if (e.type === "turn" && e.event.type === "tool_call") {
    console.log(`  [${e.agentId}] tool ${e.event.name} ${JSON.stringify(e.event.input)}`);
  } else if (e.type === "turn" && e.event.type === "tool_result" && e.event.isError) {
    console.log(`  [${e.agentId}] tool ERROR: ${e.event.output}`);
  }
}

const room = createRoom({
  vault,
  agents,
  providers: { router: routerProvider, specialist },
  router: createLlmRouter({ provider: routerProvider, agents, orchestratorId: "floor-manager" }),
  userName: "Kevin",
  defaultBoard: "pi.md",
  onEvent: show,
});

function summarize(label: string, r: SendResult): void {
  console.log(`\n=== ${label}`);
  for (const reply of r.replies) console.log(`\n[${reply.from}]\n${reply.text}`);
  if (r.suggestions.length > 0) {
    console.log(`\nSuggested next: ${r.suggestions.map((s) => `${s.agentId} (${s.reason})`).join("; ")}`);
  }
  console.log(`\nTokens this message: in ${r.usage.inputTokens} / out ${r.usage.outputTokens}\n`);
}

const NOTES = [
  "Interview A (analyst, 6 yrs): exports the case file as PDF, then re-checks every figure by hand 'in case it changed'.",
  "Interview B (analyst, 2 yrs): avoids export; screenshots the screen instead because 'export sometimes drops the last page'.",
  "Interview C (team lead): says her team lost a day last month when an export timed out and nobody knew.",
].join("\n");

console.log(`Room spike (router ${config.models.router}, specialist ${config.models.specialist})`);
console.log(`Scratch vault: ${vault.root}\n`);

try {
  summarize(
    "1. Routed message",
    await room.send("We want to understand why analysts distrust the case export step. Where should we start?"),
  );
  summarize("2. @mention with notes", await room.send(`@synthesizer Here are three sanitized notes:\n${NOTES}`));
  summarize(
    "3. Direct message with the PI board in focus",
    await room.send("Which goals are active right now, and does this export work serve one?", {
      dm: "floor-manager",
      focus: "pi.md",
    }),
  );
  console.log(`Done. Inspect the transcript and notes in: ${vault.root}`);
} catch (err) {
  if (err instanceof ProviderAuthError) {
    console.error(`\n${err.message}\n${err.hint}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
