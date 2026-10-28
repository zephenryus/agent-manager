// Starts the local server. `pnpm demo` needs no credentials; `pnpm start` uses config.local.json and Bedrock.
import { cp, mkdir, mkdtemp, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  GitUnavailableError,
  KNOWN_TOOLS,
  createBudget,
  createDemoProvider,
  createLlmRouter,
  createVaultGit,
  loadAgents,
  openVault,
  withBudget,
} from "@am/core";
import type { ModelTier, Provider } from "@am/core";
import { createApp } from "./app.ts";
import { ConfigError, DEFAULT_PORT, loadConfig } from "./config.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const publicDir = join(repoRoot, "packages", "web", "public");
const sampleVault = join(repoRoot, "sample-vault");

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    config: { type: "string", default: join(repoRoot, "config.local.json") },
    port: { type: "string" },
  },
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** First run: give a new vault the sample team and board so there is something to talk to. */
async function seedVault(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const dir of ["agents", "boards"]) {
    if (!(await exists(join(root, dir)))) await cp(join(sampleVault, dir), join(root, dir), { recursive: true });
  }
}

async function main() {
  const demo = values.demo === true;
  let port = DEFAULT_PORT;
  let vaultRoot: string;
  let userName = "You";
  let defaultBoard = "pi.md";
  let dailyLimit = 1_000_000;
  let prices: { inputPerMTok: number; outputPerMTok: number } | undefined;
  let providers: Record<ModelTier, Provider>;

  if (demo) {
    vaultRoot = await mkdtemp(join(tmpdir(), "am-demo-vault-"));
    await seedVault(vaultRoot);
    const pretend = createDemoProvider();
    providers = { router: pretend, specialist: pretend };
  } else {
    const config = await loadConfig(values.config!);
    port = config.port;
    vaultRoot = config.vaultPath;
    userName = config.userName;
    defaultBoard = config.defaultBoard;
    dailyLimit = config.dailyTokenLimit;
    prices = config.prices;
    await seedVault(vaultRoot);
    // Loaded only here so demo mode and the tests never need the AI SDK installed.
    const { createBedrockProvider } = await import("@am/core/bedrock");
    const make = (modelId: string) =>
      createBedrockProvider({ profile: config.aws.profile, region: config.aws.region, modelId });
    providers = { router: make(config.models.router), specialist: make(config.models.specialist) };
  }
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`--port must be 1-65535`);
  }

  const vault = openVault(vaultRoot);
  const budget = createBudget({
    dir: join(vault.root, "usage"),
    dailyLimit,
    ...(prices ? { prices } : {}),
  });
  const counted: Record<ModelTier, Provider> = {
    router: withBudget(providers.router, budget),
    specialist: withBudget(providers.specialist, budget),
  };

  const { agents, issues } = await loadAgents(vault.agentsDir, [...KNOWN_TOOLS]);
  for (const issue of issues) console.log(`  [roster ${issue.level}] ${issue.agentId ?? ""} ${issue.message}`);
  if (issues.some((i) => i.level === "error")) throw new ConfigError("Fix the roster errors above and start again.");
  const orchestrator = agents.find((a) => a.isOrchestrator && a.status === "active");
  if (!orchestrator) throw new ConfigError("The roster needs one active orchestrator.");

  const git = createVaultGit(vault.root);
  let history: typeof git | undefined = git;
  try {
    await git.ensureRepo();
  } catch (err) {
    if (!(err instanceof GitUnavailableError)) throw err;
    history = undefined;
    console.log("  [history] git was not found, so changes will not be saved as commits.");
  }

  const app = createApp({
    vault,
    agents,
    providers: counted,
    router: createLlmRouter({ provider: counted.router, agents, orchestratorId: orchestrator.id }),
    budget,
    ...(history ? { git: history } : {}),
    userName,
    defaultBoard,
    publicDir,
    allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
    demo,
    log: (line) => console.log(`  ${line}`),
  });

  const server = createServer((req, res) => app.handle(req, res));
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the other copy or pass --port <number>.`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
  // Loopback only: this app has no sign-in, so it must not be reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    console.log(`\nAgent manager${demo ? " (demo: pretend model, temporary vault)" : ""}`);
    console.log(`  Open http://localhost:${port}`);
    console.log(`  Vault: ${vault.root}\n`);
  });

  const stop = () => {
    app.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(`\n${err.message}\n`);
  else console.error(err);
  process.exit(1);
});
