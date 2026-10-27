import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent, TurnResult } from "../turn.ts";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Copy the sample board to a temp dir so spikes never modify the repo. */
export async function tempBoard(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "am-spike-"));
  const target = join(dir, "pi.md");
  await copyFile(join(repoRoot, "sample-vault", "boards", "pi.md"), target);
  return target;
}

export function printEvent(e: TurnEvent): void {
  if (e.type === "text") console.log(`  [assistant] ${e.text}`);
  if (e.type === "tool_call") console.log(`  [tool call] ${e.name} ${JSON.stringify(e.input)}`);
  if (e.type === "tool_result") {
    console.log(`  [tool result${e.isError ? " ERROR" : ""}] ${e.output}`);
  }
}

export async function printSummary(result: TurnResult, boardPath: string): Promise<void> {
  console.log(`\nFinal text: ${result.text}`);
  console.log(
    `Steps: ${result.steps} (${result.stopped}) | tokens in/out: ${result.usage.inputTokens}/${result.usage.outputTokens}`,
  );
  console.log(`\nBoard after turn:\n${await readFile(boardPath, "utf8")}`);
}
