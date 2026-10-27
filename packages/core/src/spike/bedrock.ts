// Live spike: one real agent turn against Bedrock with the board tools.
// Needs: config.local.json at the repo root (copy config.example.json) and fresh AWS credentials.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBoardTools } from "../boardTools.ts";
import { createBedrockProvider } from "../providers/bedrock.ts";
import { runTurn } from "../turn.ts";
import { ProviderAuthError } from "../types.ts";
import { printEvent, printSummary, repoRoot, tempBoard } from "./shared.ts";

type Config = {
  aws: { profile: string; region: string };
  models: { router: string; specialist: string };
};

const config = JSON.parse(await readFile(join(repoRoot, "config.local.json"), "utf8")) as Config;
const boardPath = await tempBoard();
const provider = createBedrockProvider({
  profile: config.aws.profile,
  region: config.aws.region,
  modelId: config.models.specialist,
});

console.log(`Bedrock spike (${provider.id}, region ${config.aws.region})\n`);
try {
  const result = await runTurn({
    provider,
    system:
      "You are the Research lead on a small product team. Use the board tools to read and update the board. Be brief.",
    messages: [
      {
        role: "user",
        text: "Look at the board, mark PI-2 active, then tell me in two sentences what is on the board.",
      },
    ],
    tools: createBoardTools(boardPath),
    maxOutputTokens: 600,
    onEvent: printEvent,
  });
  await printSummary(result, boardPath);
} catch (err) {
  if (err instanceof ProviderAuthError) {
    console.error(`\n${err.message}\n${err.hint}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
