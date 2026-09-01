<p align="center">
  <img src="apps/web/src/ui/public/logo.svg" alt="Rocketflare" width="160" />
</p>

<h1 align="center">Rocketflare</h1>

<p align="center"><strong>A multi-tenant SaaS starter kit for Cloudflare Workers — copy it, rename it, ship an internal tool or a B2B product.</strong></p>

Rocketflare is one repository that already solves the platform work every internal or B2B product
needs before its first real feature: tenancy, sign-in, roles and permissions, background jobs,
realtime, file storage, analytics dashboards, an AI layer (chat, agents, retrieval) and a CLI —
running as a single Cloudflare Worker over Postgres, with a React UI and a shared contract package
that keeps the API, the UI and the CLI in agreement. The first local run needs **zero external
credentials**, and the codebase is written to be driven by a coding agent: `CLAUDE.md`,
`.claude/rules/`, per-directory guides and a "how it works" reference mean the next feature is a
contract → schema → route → page (→ command) loop, not a platform project.

## Getting started

```bash
corepack enable && pnpm install                          # Node 24 (.nvmrc), pnpm 10, Docker running
cp apps/web/.dev.vars.example apps/web/.dev.vars         # set OAUTH_ENCRYPTION_KEY + AUTH_SIGNING_KEY (openssl rand -hex 32)
pnpm dev:db:up && pnpm db:migrate && pnpm seed           # Postgres :5432 → migrations → demo tenant + users
pnpm dev                                                 # http://localhost:3000 (API :3001)
pnpm cli login --server http://localhost:3001            # browser sign-in → tenant API key; then: pnpm cli whoami
pnpm test:db:up && pnpm test                             # full suite against a throwaway Postgres :5433
```

Sign in with the seeded owner's email; the magic-link URL is printed by `wrangler dev` (no email
provider configured). Nothing external is required: no `RESEND_API_KEY` → links are logged; no AI key
→ chat and agents answer 503 `ai_not_configured`; no Cloudflare login → comment out the `[ai]` binding.
Or ask your coding agent **"Help me set up this project"** — `CLAUDE.md` makes it run `SETUP.md`
Part 1 step by step. Copied the kit for a new app? `docs/ADAPTING.md` first.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`): one Worker exports `fetch` + `queue` + `scheduled`, a Durable Object and a Workflow |
| API | Hono 4, zod contracts, CASL abilities, JSON error envelope everywhere |
| Database | Postgres 17 + pgvector — Neon through Hyperdrive when deployed, Docker locally; Drizzle over `postgres.js`, one client per request |
| UI | React 18 + Vite, DaisyUI 5 on Tailwind v4, React Router 6, TanStack Query 5; served as Workers Static Assets |
| CLI | commander + chalk; browser login → tenant API key; `--json` on every list command |
| Async / realtime | Queues, Workflows, a per-tenant Durable Object over WebSockets, cron triggers, R2 |
| AI | Anthropic / OpenAI-compatible chat over SSE, agents on Workflows, Workers AI embeddings → pgvector, Langfuse tracing |
| Analytics | drizzle-cube semantic layer (`/cubejs-api`, `/mcp`), fact tables on a cron, TypeScript dashboard templates |
| Quality | Biome 2, strict TypeScript, vitest against real Postgres, gitleaks, one CI gate |

## Features

### Tenancy and access
- **Multi- or single-tenant from one schema** — `TENANCY_MODE=multi|single`. Every domain row carries a `tenant_id`; single mode auto-joins users to the one organisation and hides the org switcher. Flip later with no migration.
- **Sign-up policy as configuration** — `SIGNUP_MODE=open|invite_only|approval`: personal tenants, invite-only, or an access-request queue that global admins approve into a new or existing tenant, with an optional email-domain allow-list.
- **Roles and abilities** — `owner | admin | member` per tenant plus a platform `support` role and global admins; CASL abilities are computed server-side and shipped to the UI (`<Can>`, `RequireAbility`) so pages and nav use the same guard as the route.
- **Invitations and members** — create, bulk-invite, resend, revoke, accept; change roles, remove members, transfer ownership; activity log of everything.
- **Admin area** — `/admin` for global admins: tenants, users, access requests; "enter" a customer tenant as `support` with a real membership row, so the single "must be a member" invariant never bends.
- **Isolation by predicate, RLS in reserve** — every query filters by the session's tenant; every tenant table also ships a row-level-security policy, inert until `TENANT_SCOPE_MODE=enforce` (`docs/RLS.md`), with a catalog test that fails CI if a table is missed.

### Authentication
- **Magic link** (HMAC-signed, single-use, hashed at rest) — works with no email provider: the URL is logged locally.
- **OAuth registry** — Google and Microsoft via arctic; adding a provider is one definition file. Account linking by verified email, tokens AES-GCM encrypted, PKCE state in one cookie.
- **Sessions as rows** — `__Host-session` cookie, 7-day sliding TTL, one LATERAL query per request.
- **Tenant API keys** — hashed, scoped, expirable, revocable from Settings; the Bearer path shares the auth middleware and abilities with the UI.
- **Hardening built in** — CSRF by origin allow-list, KV sliding-window rate limits on login routes, security headers, body limits, dev-login that 404s in production, `gitleaks` in CI.

### Background work and realtime
- **Jobs queue** — one `JOBS_QUEUE` with typed envelopes (`email.send`, `activity.record`, `document.index`, …); invalid messages are acked (never loop), handler errors retry with capped backoff; a missing binding throws rather than running work inline.
- **Workflows** — durable multi-step runs (`claim → execute → finish`) where the database row is the claim, so retries re-claim and settled rows are never rewritten; no in-memory concurrency anywhere.
- **Cron** — a dispatcher keyed on the cron expression: nightly pruning, hourly fact-table refresh.
- **Realtime hub** — one stateless Durable Object per tenant on the hibernation API; the server "nudges" (`member.changed`, `invitation.changed`, `entity.changed { entity, id }`…) and the UI re-queries. **The database is the truth; the WebSocket is a nudge.** Reconnecting client with backoff, header status dot, outage banner.

### Email and files
- **Email** through Resend over plain `fetch` with shared templates (magic link, invitation, accepted, access decision); absent an API key, messages are logged, never failed. Invitation mail is queued; the magic link stays inline because someone is waiting.
- **File storage** on R2 behind a `StorageService` seam: tenant-prefixed keys, bytes streamed through the Worker, an indexed `files` table, per-scope MIME and size limits, avatars wired end-to-end (upload UI → `/api/files/:id` with ETag/304).

### AI layer
- **Three-tier provider resolution** — per-agent model assignment → the tenant's own provider (keys encrypted at rest, tested from Settings → AI) → a platform key → a clean 503. Providers: Anthropic, Anthropic-compatible (Fireworks, Moonshot presets), OpenAI, OpenAI-compatible (any local server such as Ollama works with no key), Workers AI for embeddings.
- **Streamed chat** — conversations and messages persisted per user, SSE frames with a shared event contract, auto-titles, prompt caching breakpoints, extended thinking off unless a tenant turns it on.
- **Prompt registry** — prompts are code with `{{variables}}`; tenants override them in Settings → Prompts and revert with one click.
- **Agents on Workflows** — `POST /api/agents/runs` enqueues and answers 202; runs are exclusive per tenant and agent via a partial unique index, emit a durable event timeline, cancel cooperatively, and reconcile against the Workflow engine on read. The `summarize-text` example shows structured output through a forced tool call; an Agents page shows live timelines.
- **Retrieval** — ingest text into `documents`/`chunks` (paragraph-aware chunking, inline or queued indexing), `vector(1024)` embeddings with an HNSW index, and **hybrid search**: dense cosine + lexical `tsvector`, fused with Reciprocal Rank Fusion. Vectors are ordinary tenant-scoped rows.
- **Usage ledger and tracing** — one `ai_usage` row per model call with token counts and a usage summary endpoint; Langfuse traces (trace → generation with usage) shipped from `waitUntil` when keys are present, no OpenTelemetry dependency.

### Analytics
- **Semantic layer** — drizzle-cube mounted at `/cubejs-api` and `/mcp` behind the app's auth; every cube scopes its SQL to the current tenant, and a mandatory isolation test queries every cube as two tenants and asserts disjoint rows.
- **Fact tables** — plain tables rebuilt per tenant in one transaction by the hourly cron, with a freshness endpoint and `pnpm web db:check-facts` for ops.
- **Dashboards** — TypeScript templates copied into each tenant's `analytics_pages` (seeded on tenant creation and lazily on first read), editable in the UI with autosave, reset-to-template and recreate; an explore/query-builder page; a shipped "Organisation Overview" dashboard.
- **MCP** — the same semantic layer is an MCP endpoint, so an AI client can query a tenant's analytics with a tenant API key.

### CLI
- `rocketflare login` opens the browser, completes sign-in and tenant selection in the app, and receives a tenant API key on a loopback callback — stored `0600` in `~/.rocketflare/config.json`, never printed in full.
- `whoami`, `status`, `members list`, `keys list`, `activity list`, `config`; `--json` prints only the parsed response so output pipes into `jq`; `ROCKETFLARE_API_KEY` / `ROCKETFLARE_URL` replace the config file in CI.
- Every response is parsed with the same zod schema the server validated with; exit codes distinguish "not logged in" (2) and "forbidden" (3) from other errors (1).

### Developer experience
- **Contracts first** — `packages/shared` holds the zod schemas the API validates with and the UI and CLI parse with; consumed as TypeScript source, no build step.
- **Two environments, one shape** — `wrangler.toml` and `wrangler.staging.toml` kept identical in everything code can observe by a parity test; account-scoped names suffixed `-staging`.
- **Release dance** — tag = root version → staging deploys; publish the GitHub Release → production ships the same tag. Migrations run in CI against the environment's Neon branch before deploy.
- **Tests that mean something** — API tests drive the real Hono app against a real Postgres; queue consumers, Workflow steps, the Durable Object and cron tasks are plain functions tested directly; UI tests in jsdom; a config project checks tomls, permissions and dashboard templates with no database.
- **Agent-readable** — `CLAUDE.md` (also `AGENTS.md`), path-scoped rules in `.claude/rules/`, a `CLAUDE.md` in every significant directory, and `docs/CONCEPTS.md` describing each subsystem, its invariant and its known gaps.
- **Design tokens** — two DaisyUI themes whose brand values live in one header block; a contrast test gates the emitted tokens.

## Layout

```
rocketflare/          workspace root: package.json (scripts delegate via pnpm -r / --filter),
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

## Not included (by design)

Billing and subscriptions, Vectorize (vectors live in pgvector under the tenant predicate), file
parsing pipelines (ingest takes text), reranking, prompt versioning and evals, reporting/export, and
any product domain. Each is a documented extension point in `docs/CONCEPTS.md`; the subsystem sections
there list every known gap.

## Documentation

| File | Read it when |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md`) | always — the canonical agent context: stack, commands, map, non-negotiables |
| [`SETUP.md`](SETUP.md) | getting a clone running, the CLI's first login, configuring OAuth/email/AI providers (or a local OpenAI-compatible mock)/Langfuse, deploying to Cloudflare |
| [`docs/CONCEPTS.md`](docs/CONCEPTS.md) | before assuming a capability exists or building a new one — one section per subsystem with its invariant and known gaps |
| [`docs/ADAPTING.md`](docs/ADAPTING.md) | you just copied the kit to start an app (package names, CLI bin, config dir, env prefix, what to delete, where the first features go) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Cloudflare topology, the two tomls, resources, release dance, rollback, bundle size |
| [`docs/RLS.md`](docs/RLS.md) | tenant isolation posture and how to turn row-level security on |
| `.claude/rules/*.md` | layer conventions (api, database, ui, cli, testing, code-quality, cloudflare) — auto-loaded by path |
| `docs/analysis/` | the decision record the kit was built from (provenance; not maintained) |

## Provenance

Extracted from two internal applications: one contributed the structure, docs system, auth,
tenancy and AI layer; the other the Cloudflare substrate (Hyperdrive, Queues, Workflows, Durable
Objects, two-toml deploys) and the analytics layer. Decisions are recorded in `docs/analysis/00-SYNTHESIS.md`.

## Licence

Private for now — licence to be confirmed before any external distribution.
