# GMGO Starter Kit

Multi-tenant SaaS starter for internal GM apps: Hono API + React UI in one Cloudflare Worker,
Postgres (Neon via Hyperdrive) + Drizzle, arctic auth, CASL, drizzle-cube analytics, an AI layer.
`AGENTS.md` is a symlink to this file.

> **How it works**: @docs/CONCEPTS.md — what is built and why, one section per subsystem, each with
> its known gaps. **Check it before assuming a capability exists or building one; update the section
> when you change how one works.**
>
> **Setup**: @SETUP.md — instructions only. When asked for setup help, don't summarise it: **run Part 1
> step by step** — execute each command, show the output, confirm the verification line before the
> next step; stop and surface a failure. Fix missing prerequisites proactively (Node via `.nvmrc`,
> `corepack enable` for pnpm, Colima on macOS if Docker is absent) and carry on.
>
> **Fresh copy?** @docs/ADAPTING.md — if this repo was just copied to start a new app, start there.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat`); one Worker exports `fetch` + `queue` +
  `scheduled` and the in-script Durable Object / Workflow classes (`src/worker.ts`). Node 24, pnpm 10
- **API**: Hono 4, zod contracts in `src/shared/`, CASL, pino (hono-pino)
- **DB**: Postgres 17 + pgvector — Neon through **Hyperdrive** when deployed, Docker locally;
  Drizzle over `postgres.js` (only driver), one client per request
- **Auth**: arctic (Google, Microsoft) + magic link + dev-login; `__Host-session` cookie; API keys;
  **KV** rate limit
- **Async / realtime**: **Queues** (`JOBS_QUEUE`), **Workflows** (`AGENT_RUN_WORKFLOW`), cron;
  `NotificationsHub` **Durable Object** at `/ws`
- **Storage / AI**: **R2** (`FILES`); **Workers AI** embeddings → pgvector; Anthropic-compatible chat;
  Langfuse over fetch
- **UI**: React 18 + Vite, DaisyUI 5 / Tailwind v4 (`gm-light`/`gm-dark`), React Router 6, TanStack
  Query 5; served as **Static Assets** (`ASSETS`)
- **Tests**: vitest projects `api` · `api-isolated` · `ui` · `config`, real Postgres on 5433
- **Lint**: Biome 2 (single quotes, `asNeeded` semicolons, 100 cols)

## Commands

```bash
pnpm dev:db:up && pnpm db:migrate   # Postgres :5432; db-roles(role) → migrations → db-roles(grants)
pnpm seed                            # demo tenant/users/API key (Phase 1)
pnpm dev                             # wrangler dev :3001 + vite :3000 (proxies /api /auth /ws /cubejs-api)
pnpm dev:tunnel                      # same behind a cfld tunnel; public APP_URL passed to wrangler
pnpm test:db:up && pnpm test         # test Postgres :5433; test:api / test:ui / test:config
pnpm lint  ·  pnpm typecheck  ·  pnpm build        # biome · wrangler types + tsc · vite + dry-run deploy
pnpm db:generate  ·  pnpm db:studio  ·  pnpm provision <staging|production>
```

No `RESEND_API_KEY` → magic-link URLs are logged by `wrangler dev`; zero credentials needed locally.

## Architecture

```
src/
├── worker.ts          # export default { fetch, queue, scheduled }; export { NotificationsHub, AgentRunWorkflow }
├── config.ts          # loadConfig(env): zod over Cloudflare.Env, memoised per isolate; routes read c.get('config')
├── shared/            # zod contracts shared by API and UI (src/shared/CLAUDE.md)
├── permissions/       # CASL: owner/admin/member/support + isGlobalAdmin (src/permissions/CLAUDE.md)
├── db/                # client.ts, tenant-scope.ts, schema/ one file per table (src/db/schema/CLAUDE.md)
├── dashboards/        # drizzle-cube templates
├── api/
│   ├── index.ts       # Hono app + middleware order; ASSETS catch-all with /api|/auth 404 guard
│   ├── queue.ts  scheduled.ts          # JOBS_QUEUE consumer; cron dispatcher on event.cron
│   ├── middleware/    # config, logger, security, body-limit, cors, csrf, database, auth… (CLAUDE.md)
│   ├── auth/  routes/  services/       # provider registry; thin controllers (routes/CLAUDE.md); (db, cfg, logger) services
│   ├── cubes/  workflows/  durable-objects/  observability/
│   └── utils/         # core/{errors,logger,ids}  routes/{router,validate,route-helpers,pagination}
└── ui/                # React app (src/ui/CLAUDE.md)
```

## Config model

`[vars]` in both tomls, read via `loadConfig(env)`: `APP_ENV` (`development|staging|production`) ·
`TENANCY_MODE` (`multi|single` — single hides org switching and auto-joins the one tenant; same
schema) · `SIGNUP_MODE` (`open|invite_only|approval`, default `invite_only`;
`BOOTSTRAP_ADMIN_EMAILS` seeds the first admin) · `TENANT_SCOPE_MODE` (`off|enforce`, RLS —
@docs/RLS.md). Secrets: `.dev.vars` locally, `wrangler secret put` deployed, never in a toml.

Rules (auto-loaded by path): @.claude/rules/api.md · database.md · ui.md · testing.md ·
code-quality.md · cloudflare.md. Runbooks: @docs/DEPLOY.md (topology, release dance, rollback) ·
@docs/RLS.md.

## Non-Negotiables

- **Gate**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass before every commit
- **Tenant isolation**: every domain query filters by `tenantId` from the auth context, and every
  tenant table calls `tenantIsolation()` (RLS inert by default; `rls-coverage.test.ts` enforces)
- **Contracts first**: zod schema in `src/shared/` → route `validate()` → UI parse, same schema; errors
  are `{ error, statusCode, code?, details? }`
- **Routes enqueue, never run**: long work → `JOBS_QUEUE` or a Workflow; side effects in `waitUntil`;
  concurrency is a DB claim row, never an in-memory `Map`
- **Two tomls, one shape**: bindings, class names, `compatibility_*`, `[limits]`, crons identical in
  `wrangler.toml` and `wrangler.staging.toml`; account-scoped names differ (`wrangler-parity.test.ts`)
- **Secrets** never in a toml or git; `.dev.vars` comments are not a place for other credentials;
  `gitleaks` runs in CI
- **No `process.env` and no Node-only APIs in `src/`** (`pg`, `ws`, `node:fs`, `pg-boss`…);
  `pnpm build:api` catches them
- **Docs in sync**: a behaviour change updates CONCEPTS / SETUP / DEPLOY / rules in the same change
