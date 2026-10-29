# agent-manager (working name)

A browser-based "office" for managing a small team of AI agents for product discovery and design work.
Design spec: see the Agents manager project, `claude/spec-v0.md`.

## Status: P1 (room, two-pane UI)

Run the app:

```
pnpm install
pnpm demo     # pretend model, temporary vault, no credentials needed
pnpm start    # real: reads config.local.json, talks to Bedrock
```

Then open http://localhost:4317 (demo: the port is printed). The server only listens on this computer.

`pnpm start` needs `config.local.json` (copy `config.example.json`). `vaultPath` is where your real boards, notes and
transcripts live; it is created on first run (seeded from `sample-vault`) and should NOT be inside this repo.
It is its own git repo, and every message you send is saved as a commit there. `dailyTokenLimit` is the day's token
budget (input + output); the pen at the bottom of the board shows what is left, warns at 80% and stops at 100%.
A limit only matters when tokens cost money, so it can be turned off: set `"dailyTokenLimit": null` for no limit
(usage is still counted and shown). Left out, it is 200,000 for Bedrock and no limit for a local Ollama model.

Agent files: each agent gets a personal folder, `workspaces/<agent-id>/`, and the team shares `workspaces/shared/`.
Agents with the `files_write` tool (listed in their frontmatter) can write only there; everyone with `files_read`
can read every workspace. `readableFolders` (config, default `["Interviews"]`) adds more read-only folders, and
`workspaces` is always readable. Lists in agent frontmatter can be inline (`tools: [a, b]`) or block style.

Briefs: ask the Floor manager for a short brief and it saves one (with `brief_write`, which builds the page from a title, bottom line, bullets and details, and rejects paths that do not exist) in `workspaces/shared/briefs/`. The Briefs tab on the
right lists them (newest first) and opens one to read. They are plain markdown files, so you can edit or add your own.

Work log: the team shares a plain-text log in `worklog/YYYY-MM-DD.md`, one line per piece of work. The app adds a line
(marked `(auto)`) after any turn that saved a file or changed a board, and agents add their own with `worklog_add`.
Agents with `worklog_read` get the latest lines in their prompt, so the Floor manager can say what has been done.
Every agent call is also told the current date and time.

Local model (Ollama, no cloud, no cost): install Ollama, run `ollama pull gemma4:e4b`, copy
`config.ollama.example.json` to a config of your own, point `vaultPath` at a throwaway vault, and start with
`node packages/server/src/main.ts --config <your config>`. The router and the specialists can use different models.
`numCtx` is the context window: keep it large enough for the charter, transcript and boards (16384 is a good start),
because Ollama silently cuts off the start of a prompt that is too long. `think: false` skips the model's reasoning
step, which is faster; leave it out to let the model decide. Small local models call tools less reliably than
Sonnet, so expect the router to fall back to the Floor manager more often.

Lower-level checks, no UI:

```
pnpm install
pnpm test           # fake-provider tests, no network
pnpm spike:fake     # scripted turn, prints the tool round trip
```

Live Bedrock check (needs credentials in your AWS profile):

```
cp config.example.json config.local.json   # then edit profile/region/models
pnpm spike:bedrock
```

Credentials are never stored by this app: it uses the standard AWS credential chain with the profile named in
`config.local.json`. If the token has expired the spike tells you to refresh it.

## Layout

- `packages/core` — agents, boards, turn loop, router, budget, provider seam. No HTTP or UI.
- `packages/server` — local HTTP + server-sent events, serves the UI. Node built-ins only.
- `packages/web` — the two-pane UI: plain HTML, CSS and JavaScript, no build step.
- `sample-vault/` — fake data for demos and tests. Your real vault lives outside this repo.
