# Rocketflare

A multi-tenant SaaS starter for internal applications, packaged as one repository you copy and
rename. It is a **pnpm workspace** of three packages: `apps/web` (Hono API + React UI in a single
Cloudflare Worker), `apps/cli` (a commander CLI that logs in through the browser and talks to the API
with a tenant key) and `packages/shared` (private zod contracts consumed by all three). Postgres on
Neon through Hyperdrive with Drizzle; arctic OAuth + magic-link auth; CASL permissions; drizzle-cube
analytics; an AI layer (chat, agents on Workflows, tracing, pgvector retrieval). Zero external
credentials are needed for the first local run.

**Who it is for.** Engineers starting an internal product who want tenancy, auth, permissions,
background work, realtime, analytics, AI plumbing and a CLI solved on day one — and an agent-readable
codebase (`CLAUDE.md`, `.claude/rules/`, per-directory guides) so the next feature is a
contract-schema-route-page(-command) loop, not a platform project. Not a public framework.

## Layout

```
rocketflare/                 workspace root: package.json (scripts delegate via pnpm -r / --filter),
│                     pnpm-workspace.yaml, biome.json, tsconfig.base.json, CLAUDE.md, docs/, .github/
├── apps/web/         @rocketflare/web — Worker (Hono API) + React UI; wrangler*.toml, migrations/, scripts/, tests/
├── apps/cli/         @rocketflare/cli — `rocketflare` CLI: login, logout, whoami, status, members/keys/activity list, config
└── packages/shared/  @rocketflare/shared — PRIVATE zod contracts, error envelope, pagination, permission types;
                      consumed as TypeScript source through the workspace link (no build step)
```

Everything runs from the root: `pnpm dev`, `pnpm test`, `pnpm cli …`, `pnpm web <script>` (any
`apps/web` script), `pnpm db:*`, `pnpm deploy[:staging]`, `pnpm provision`. `wrangler` is a
devDependency of `apps/web`, so it is `pnpm --filter @rocketflare/web exec wrangler …`, never `pnpm exec
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
| Shared contracts package (`@rocketflare/shared`) | **Phase 0 — done** | zod schemas imported by API, UI and CLI; private, no build |
| Identity: users, tenants, roles, invitations, access requests, magic link, Google/Microsoft OAuth, API keys, admin area | Phase 1 — done | `TENANCY_MODE` multi/single, `SIGNUP_MODE`; `GET /auth/cli` handoff for the CLI |
| CLI: `login` (browser → loopback → API key in `~/.rocketflare`), `whoami`, `status`, tenant-scoped list commands, `--json` | Phase 1 — done | `ROCKETFLARE_API_KEY` / `ROCKETFLARE_URL` env overrides for CI |
| Realtime: `NotificationsHub` Durable Object (one per tenant, hibernation, RPC) + `GET /ws`, `services/realtime.ts` nudges, shared event contract, reconnecting client + status dot/banner | **Phase 2 — done** | "DB is the truth, WebSocket is a nudge": events invalidate TanStack queries, never carry state |
| Background jobs: `JOBS_QUEUE` producer/consumer with typed envelopes (`email.send`, `activity.record`, `example.ping`), poison → ack, error → backoff retry; invitation + access-request emails queued; daily cron | **Phase 2 — done** | prefix-matched queue dispatch so staging's `-staging` name needs no code change; magic link stays inline |
| File storage: R2 `FILES` behind `StorageService`, `files` table index (RLS), `POST/GET/DELETE /api/files`, 5 MB per file, avatar upload UI | **Phase 2 — done** | tenant-prefixed keys, streamed through the Worker, no presigned URLs; `avatarUrl` is global but the object is tenant-scoped (known gap) |
| AI: three-tier provider config (per-agent `agent_models` → tenant `ai_configs`, encrypted keys → platform `ANTHROPIC_API_KEY`), Settings → AI / Prompts / Usage, streamed chat (SSE), prompt registry + overrides, `ai_usage` ledger | **Phase 3a — done** | providers `anthropic`, `anthropic_compatible` (Fireworks/Moonshot presets), `openai`, `openai_compatible`; thinking off by default; 503 `ai_not_configured` when nothing resolves; Langfuse tracing when both keys are set (fetch batcher, no OpenTelemetry) |
| Agents on Workflows: `AgentRunWorkflow` (`claim → execute → finish`), `agent_runs` claim row + partial unique index (exclusive), `agent_run_events` + realtime nudge, cooperative cancel, reconcile-on-read, example `summarize-text`; per-agent model assignment; pgvector ingest (`documents`/`chunks`, inline or `document.index` job) + hybrid dense/lexical RRF search | **Phase 3b — done** | `[[workflows]]` `AGENT_RUN_WORKFLOW` (account-scoped name, `-staging`), `[ai]` Workers AI embeddings (`@cf/baai/bge-m3`, 1024-dim) with `EMBEDDINGS_API_KEY` fallback |
| Agents / Knowledge / Agent-models UI: `/agents` (+ `/agents/runs/:id` drawer with the live timeline, cancel), `/documents` (ingest, hybrid search), Settings → Agent models | **Phase 3b-UI — done** | poll while active + `entity.changed { entity: 'agent-run' }` nudge (entity string = query-key root); documents poll while `pending`; specifics in `apps/web/src/ui/CLAUDE.md` |
| Analytics server: drizzle-cube semantic layer at `/cubejs-api` + `/mcp` (per-request `createCubeApp`, every cube tenant-scoped in `sql()`), cubes `Users`/`TenantUsers`/`ActivityEvents`/`TenantActivityDaily`, fact table `tenant_activity_daily_facts` rebuilt per tenant by the `15 * * * *` cron + freshness check, dashboard templates copied into `analytics_pages` per tenant with reset/recreate, `/api/analytics/*` | **Phase 4 — server done** | `tests/api/cubes/cube-isolation.test.ts` is the isolation guarantee (convention, not enforcement); member names are frozen (stored dashboards reference them); `pnpm web db:refresh-facts` / `db:check-facts` |
| Analytics UI: `/analytics` list/view/explore over drizzle-cube's React components (recharts), edit mode with autosave, reset-to-template, URL-synced date range | **Phase 4 — done** | lazy chunk (~377 KB gzip) — main bundle unchanged; `CubeClientProvider` supplies cookie auth + a dedicated QueryClient so 401s reach the app's handler; see `apps/web/src/ui/CLAUDE.md` |
| Ship-ready: `deploy.yml` release dance, `cf-provision.sh`, `SETUP.md` Part 3, `DEPLOY.md` | Phase 5 — **docs and scripts done**, exercised once code exists | one tag (= root `package.json` version) ships web; the CLI is not deployed |

Out of scope for v1: billing, Vectorize (vectors live in pgvector), voice, file-parsing document pipelines
(ingest takes text), rerank, prompt versioning, export/reporting, evals.

Dependencies the AI layer adds to `apps/web`: `@anthropic-ai/sdk` (fetch-based; its `node:fs`
credential-chain imports are dynamic and inert under `nodejs_compat`), `zod-to-json-schema` (tool
schemas), `react-markdown` + `remark-gfm` (UI, isolated to the lazy chat chunk). Analytics adds
`drizzle-cube@0.8.3` (pinned exactly; one expected `@duckdb/node-api` peer warning) plus `recharts`,
`d3`, `react-grid-layout`, `react-is` for its UI. Measured bundle: UI main chunk ≈ 114 KiB gzip, chat
chunk ≈ 54 KiB gzip; **`dist/api/worker.js` ≈ 1265 KiB gzip (≈ 5.6 MB raw), up from ≈ 308 KiB** —
`drizzle-cube/adapters/hono` statically imports its MCP transport (≈ 2.1 MB raw) even with MCP
disabled; under the Workers limit, fix is upstream (`docs/DEPLOY.md` "Bundle size").

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

Extracted from two internal applications: one contributed the structure, docs system, auth,
tenancy and AI layer; the other the Cloudflare substrate (Hyperdrive, Queues, Workflows, Durable
Objects, two-toml deploys) and the analytics layer. Decisions are recorded in `docs/analysis/00-SYNTHESIS.md`.

## Licence

Internal. Licence to be confirmed before any external distribution.
