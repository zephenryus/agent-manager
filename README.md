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
