# agent-manager (working name)

A browser-based "office" for managing a small team of AI agents for product discovery and design work.
Design spec: see the Agents manager project, `claude/spec-v0.md`.

## Status: P0 spike

Goal: prove one agent turn with one tool call round-trips, first against a fake provider, then against Bedrock.

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

- `packages/core` — agents, boards, turn loop, provider seam. No HTTP or UI.
- `sample-vault/` — fake data for demos and tests. Your real vault lives outside this repo.
