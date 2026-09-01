# GMGO Starter Kit

A multi-tenant SaaS starter for GM-internal applications, packaged as one repository you copy and
rename. It is a **pnpm workspace** of three packages: `apps/web` (Hono API + React UI in a single
Cloudflare Worker), `apps/cli` (a commander CLI that logs in through the browser and talks to the API
with a tenant key) and `packages/shared` (private zod contracts consumed by all three). Postgres on
Neon through Hyperdrive with Drizzle; arctic OAuth + magic-link auth; CASL permissions; drizzle-cube
analytics; an AI layer (chat, agents on Workflows, tracing, pgvector retrieval). Zero external
credentials are needed for the first local run.

**Who it is for.** GM engineers starting an internal product who want tenancy, auth, permissions,
background work, realtime, analytics, AI plumbing and a CLI solved on day one — and an agent-readable
codebase (`CLAUDE.md`, `.claude/rules/`, per-directory guides) so the next feature is a
contract-schema-route-page(-command) loop, not a platform project. Not a public framework.

## Layout

```
gmgo/                 workspace root: package.json (scripts delegate via pnpm -r / --filter),
│                     pnpm-workspace.yaml, biome.json, tsconfig.base.json, CLAUDE.md, docs/, .github/
├── apps/web/         @gmgo/web — Worker (Hono API) + React UI; wrangler*.toml, migrations/, scripts/, tests/
├── apps/cli/         @gmgo/cli — `gmgo` CLI: login, logout, whoami, status, members/keys/activity list, config
└── packages/shared/  @gmgo/shared — PRIVATE zod contracts, error envelope, pagination, permission types;
                      consumed as TypeScript source through the workspace link (no build step)
```

Everything runs from the root: `pnpm dev`, `pnpm test`, `pnpm cli …`, `pnpm web <script>` (any
`apps/web` script), `pnpm db:*`, `pnpm deploy[:staging]`, `pnpm provision`. `wrangler` is a
devDependency of `apps/web`, so it is `pnpm --filter @gmgo/web exec wrangler …`, never `pnpm exec
wrangler` at the root.

## Getting started

Ask your coding agent: **"Help me set up this project"** — `CLAUDE.md` instructs it to run
`SETUP.md` Part 1 step by step and fix missing prerequisites. Or by hand, from the root:

```bash
corepack enable && pnpm install                          # Node 24 (.nvmrc), pnpm 10
cp apps/web/.dev.vars.example apps/web/.dev.vars         # then fill the two keys: openssl rand -hex 32
pnpm dev:db:up && pnpm db:migrate && pnpm seed
pnpm dev                                                 # http://localhost:3000 (API on :3001)
pnpm test:db:up && pnpm test
pnpm cli login --server http://localhost:3001 && pnpm cli whoami   # CLI first run (browser opens)
```

Sign in with the seeded owner's email; the magic-link URL is printed by `wrangler dev` because no
email provider is configured. Just copied the kit for a new app? Read `docs/ADAPTING.md` first.

## What's included

| Subsystem | Status | Notes |
|---|---|---|
| Workspace tooling, tomls, CI gate, docs system, parity test | **Phase 0 — done** | `ci.yml`, two `apps/web/wrangler*.toml`, `apps/web/tests/config/wrangler-parity.test.ts`, this doc set |
| Config, DB client, schema helpers, RLS scaffolding, migrations | **Phase 0 — done** | `loadConfig(env)`, postgres.js per request, `tenantIsolation()` inert |
| API shell: middleware chain, error envelope, `/api/health`, UI shell | **Phase 0 — done** | Hono app + React renders |
| Shared contracts package (`@gmgo/shared`) | **Phase 0 — done** | zod schemas imported by API, UI and CLI; private, no build |
| Identity: users, tenants, roles, invitations, access requests, magic link, Google/Microsoft OAuth, API keys, admin area | Phase 1 — done | `TENANCY_MODE` multi/single, `SIGNUP_MODE`; `GET /auth/cli` handoff for the CLI |
| CLI: `login` (browser → loopback → API key in `~/.gmgo`), `whoami`, `status`, tenant-scoped list commands, `--json` | Phase 1 — done | `GMGO_API_KEY` / `GMGO_URL` env overrides for CI |
| Realtime: `NotificationsHub` Durable Object (one per tenant, hibernation, RPC) + `GET /ws`, `services/realtime.ts` nudges, shared event contract, reconnecting client + status dot/banner | **Phase 2 — done** | "DB is the truth, WebSocket is a nudge": events invalidate TanStack queries, never carry state |
| Background jobs: `JOBS_QUEUE` producer/consumer with typed envelopes (`email.send`, `activity.record`, `example.ping`), poison → ack, error → backoff retry; invitation + access-request emails queued; daily cron | **Phase 2 — done** | prefix-matched queue dispatch so staging's `-staging` name needs no code change; magic link stays inline |
| File storage: R2 `FILES` behind `StorageService`, `files` table index (RLS), `POST/GET/DELETE /api/files`, 5 MB per file, avatar upload UI | **Phase 2 — done** | tenant-prefixed keys, streamed through the Worker, no presigned URLs; `avatarUrl` is global but the object is tenant-scoped (known gap) |
| AI: three-tier provider config (per-agent `agent_models` → tenant `ai_configs`, encrypted keys → platform `ANTHROPIC_API_KEY`), Settings → AI / Prompts / Usage, streamed chat (SSE), prompt registry + overrides, `ai_usage` ledger | **Phase 3a — done** | providers `anthropic`, `anthropic_compatible` (Fireworks/Moonshot presets), `openai`, `openai_compatible`; thinking off by default; 503 `ai_not_configured` when nothing resolves; Langfuse tracing when both keys are set (fetch batcher, no OpenTelemetry) |
| Agents on Workflows: `AgentRunWorkflow` (`claim → execute → finish`), `agent_runs` claim row + partial unique index (exclusive), `agent_run_events` + realtime nudge, cooperative cancel, reconcile-on-read, example `summarize-text`; per-agent model assignment; pgvector ingest (`documents`/`chunks`, inline or `document.index` job) + hybrid dense/lexical RRF search | **Phase 3b — done** | `[[workflows]]` `AGENT_RUN_WORKFLOW` (account-scoped name, `-staging`), `[ai]` Workers AI embeddings (`@cf/baai/bge-m3`, 1024-dim) with `EMBEDDINGS_API_KEY` fallback; agent/document/agent-model pages: see `apps/web/src/ui/CLAUDE.md` |
| Analytics: drizzle-cube cubes, fact-table refresh, dashboard templates, query builder | Phase 4 — planned | two-tenant isolation test mandatory |
| Ship-ready: `deploy.yml` release dance, `cf-provision.sh`, `SETUP.md` Part 3, `DEPLOY.md` | Phase 5 — **docs and scripts done**, exercised once code exists | one tag (= root `package.json` version) ships web; the CLI is not deployed |

Out of scope for v1: billing, Vectorize (vectors live in pgvector), voice, file-parsing document pipelines
(ingest takes text), rerank, prompt versioning, export/reporting, evals.

Dependencies the AI layer adds to `apps/web`: `@anthropic-ai/sdk` (fetch-based; its `node:fs`
credential-chain imports are dynamic and inert under `nodejs_compat`), `zod-to-json-schema` (tool
schemas), `react-markdown` + `remark-gfm` (UI, isolated to the lazy chat chunk). Measured bundle:
`dist/api/worker.js` ≈ 308 KiB gzip; UI main chunk ≈ 114 KiB gzip, chat chunk ≈ 54 KiB gzip.

## Documentation

| File | Read it when |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md`) | always — the canonical agent context: stack, commands, map, non-negotiables |
| [`SETUP.md`](SETUP.md) | getting a clone running, the CLI's first login, configuring OAuth/email/AI providers (or a local OpenAI-compatible mock)/Langfuse, deploying to Cloudflare |
| [`docs/CONCEPTS.md`](docs/CONCEPTS.md) | before assuming a capability exists or building a new one (includes the CLI and shared package) |
| [`docs/ADAPTING.md`](docs/ADAPTING.md) | you just copied the kit to start an app (package names, CLI bin, config dir, env prefix) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Cloudflare topology, the two tomls, release dance, rollback |
| [`docs/RLS.md`](docs/RLS.md) | tenant isolation posture and how to turn row-level security on |
| `.claude/rules/*.md` | layer conventions (api, database, ui, cli, testing, code-quality, cloudflare) — auto-loaded by path |
| `docs/analysis/` | the decision record the kit was built from (provenance; not maintained) |

## Provenance

Extracted from two internal GM applications: one contributed the structure, docs system, auth,
tenancy and AI layer; the other the Cloudflare substrate (Hyperdrive, Queues, Workflows, Durable
Objects, two-toml deploys) and the analytics layer. Decisions are recorded in `docs/analysis/00-SYNTHESIS.md`.

## Licence

Internal — GM. Licence to be confirmed before any external distribution.
