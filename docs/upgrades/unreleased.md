---
version: unreleased
previous: 0.8.1
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A plugin's `agentTools` may now be async and answer per tenant, and `@/plugins/api` exports `sealSecret`/`openSecret` so a plugin can store a tenant's credential encrypted.

- `ServerPlugin.agentTools` returns `Tool[] | Promise<Tool[]>`. A builder that throws is logged and skipped rather than failing the run.
- `buildAgentTools` is `async`; `runtime.ts`, `chat-turn.ts` (`buildTools` returns a Promise) and `chat-stats.ts` await it.
- `pnpm plugin add` sorts a new barrel import against `import type … from './types'` too, as Biome does, so a plugin whose id sorts after `types` (`web-knowledge`) no longer fails the barrel round-trip test.
- New `apps/web/src/plugins/api/secrets.ts`: `sealSecret(config, plaintext)` / `openSecret(config, sealed)` over the kit's AES-GCM, 503 `encryption_key_missing` without `OAUTH_ENCRYPTION_KEY`.

## How to apply

1. Take `scripts/lib/plugin-lib.mjs`, `apps/web/src/api/services/agents/tools/index.ts`, `apps/web/src/plugins/types.ts`, `apps/web/src/plugins/api/secrets.ts` and `apps/web/src/plugins/api/index.ts` from the kit.
2. In `apps/web/src/api/services/agents/runtime.ts`, `apps/web/src/api/services/ai/chat-stats.ts` and every call site of your own, write `await buildAgentTools(…)`.
3. In `apps/web/src/api/services/ai/chat-turn.ts`, type `buildTools` as `(db: Database) => Promise<Tool[]>`, `await params.buildTools(sdb)`, and make the disabled branch `async () => []`.
4. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.

## Conflicts to expect

`apps/web/src/api/services/agents/tools/index.ts` → `buildAgentTools` became async → keep any tools you appended and keep the `await` on every caller.

## Verify

1. `pnpm typecheck` passes (a missed `await` on `buildAgentTools` is a type error where a `Tool[]` is expected).
2. `node scripts/plugin-api-doc.mjs --check` prints `up to date`.
3. `pnpm web test:api` passes, including `tests/api/plugin-agent-tools.test.ts`.
