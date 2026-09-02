# Rocketflare

Multi-tenant SaaS starter for internal tools and B2B products, a **pnpm workspace**: Hono API + React UI in one
Cloudflare Worker (`apps/web`), a CLI (`apps/cli`), private zod contracts
(`packages/shared`). `AGENTS.md` symlinks here.

> **How it works**: @docs/CONCEPTS.md — one section per subsystem with its known gaps. **Check it
> before assuming a capability exists; update it when you change one.**
> **Setup**: asked for setup help → run `/setup` (it drives `scripts/bootstrap.sh --no-dev`, then
> starts the server): show each `✔ n/9` line, stop on failure. By hand: @SETUP.md Part 1.
> **Fresh copy?** `/adapt <slug>`, then @docs/ADAPTING.md. `/setup`, `/adapt` and `/preflight` you
> may run yourself; **`/provision` is user-invoked only** (it creates paid resources and prompts for
> tokens on a TTY) — asked to deploy, tell the user to run `/provision`.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat`); one Worker exports `fetch`+`queue`+`scheduled`
  + DO/Workflow classes (`src/worker.ts`). Node 24, pnpm 10
- **API**: Hono 4, zod contracts from `@rocketflare/shared`, CASL. **DB**: Postgres 17 + pgvector —
  Neon via Hyperdrive deployed, Docker locally; Drizzle over `postgres.js` (only driver), 1 client/request
- **Auth**: arctic (Google, Microsoft) + magic link + dev-login; `__Host-session`; API keys; KV rate limit
- **Async / realtime**: Queues (`JOBS_QUEUE`), `NotificationsHub` DO `/ws`, R2 (`FILES`), cron, Workflows
- **AI**: `services/ai/resolve` (`agent_models` → tenant `ai_configs` → platform key → Workers AI via
  `[ai]`, zero key → 503); Anthropic / OpenAI-compatible / Workers AI chat over SSE, agents on `AGENT_RUN_WORKFLOW`, Workers AI → pgvector (uploads: R2 → `AI.toMarkdown` → pgvector), Langfuse
- **Analytics**: drizzle-cube at `/cubejs-api`+`/mcp`, every cube tenant-scoped in `sql()`; fact tables
  on the `:15` cron; TS dashboard templates → `analytics_pages`
- **UI**: React 18 + Vite, DaisyUI 5 / Tailwind v4, React Router 6, TanStack Query 5; served as `ASSETS`
- **CLI**: commander + chalk + open; `tsx` in dev, `tsc` → `dist/cli.js` (bin `rocketflare`)
- **Tests**: vitest projects `api` · `api-isolated` · `ui` · `config` (Postgres :5433); cli
- **Lint**: Biome 2 at the root (single quotes, `asNeeded` semicolons, 100 cols)

## Commands (from the workspace root)

```bash
pnpm bootstrap · pnpm preflight  # first run in one go (--offline/--online toggle [ai]) / read-only check
pnpm dev:db:up && pnpm db:migrate  # Postgres on the first free port from :5432 → DATABASE_URL; role → migrations → grants
pnpm seed [--demo] && pnpm dev  # tenant/users/key (+ populated workspace); wrangler :3001 + vite :3000 (strict ports)
pnpm dev:stop · pnpm dev:status · pnpm dev:db:status  # kill this repo's dev tree / port holders / every dev database
pnpm cli login --server http://localhost:3001  # browser → ~/.rocketflare/config.json, then whoami
pnpm test:db:up && pnpm test  # every package; web loads .env.test
pnpm lint · pnpm typecheck · pnpm build  # workspace-wide
pnpm web <script>  # any apps/web script (test:api, db:check, db:*-facts…)
pnpm db:generate · pnpm db:studio · pnpm deploy[:staging] · pnpm provision all  # (or one phase: --help)
```

`wrangler` lives in `apps/web`: `pnpm --filter @rocketflare/web exec wrangler …`, never at the root. No
`RESEND_API_KEY` → magic-link URLs are logged; no AI key → chat/agents 503; zero creds locally.

## Architecture

```
apps/web/          @rocketflare/web — wrangler*.toml, worker-configuration.d.ts, .dev.vars(.example), .env.test,
│                  drizzle.config.ts, migrations/, scripts/, tests/
│  src/worker.ts   export default { fetch, queue, scheduled }; export { NotificationsHub, AgentRunWorkflow }
│  src/config.ts   loadConfig(env): zod over Cloudflare.Env; routes read c.get('config')
│  src/permissions/  CASL owner/admin/member/support + isGlobalAdmin   src/db/  client, tenant-scope, schema/
│  src/api/        index.ts (Hono app, middleware order, ASSETS catch-all) · queue.ts · scheduled.ts ·
│                  middleware/ · auth/ · routes/ (thin) · cubes/ (drizzle-cube, tenant-scoped) · services/ (ai/,
│                  agents/, fact-tables/, prompts.ts) · workflows/ · observability/ · utils/ · queues/ · durable-objects/
│  src/dashboards/ TS dashboard templates → analytics_pages    src/ui/  React app
│                  (per-dir CLAUDE.md: permissions, db/schema, dashboards, api/*, ui)
apps/cli/          @rocketflare/cli — src/cli.ts, commands/*, api.ts (only fetch site), config.ts, login.ts
packages/shared/   @rocketflare/shared — src/*.ts zod contracts, errors, pagination, permissions (CLAUDE.md)
scripts/           bootstrap.sh → bootstrap.mjs (9 steps), install.sh (curl one-liner), rename.mjs, lib/
.claude/skills/    setup · preflight · adapt (+ checklist.md) · provision (+ reference.md) ·
                   how-do-i (+ example-orders.md — coaching for a new feature, plans only)
```

**`packages/shared`.** Private, no build: `@rocketflare/shared/<module>` → `./src/<module>.ts` (incl. `ai/*`,
`analytics`). Imports only `zod`, siblings, type-only `@casl/ability`.

**`apps/cli`.** `login` opens `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; the server
mints a tenant API key `cli:<host>` → `?key=&tenant_id=&tenant_name=`; stored `0600` in
`~/.rocketflare/config.json` (`ROCKETFLARE_API_KEY`/`ROCKETFLARE_URL` for CI). Also `logout|whoami|status|config`,
`members|keys|activity list --json` (@.claude/rules/cli.md)

## Config model

`[vars]` in both tomls, read via `loadConfig(env)`: `APP_ENV` (`development|staging|production`) ·
`TENANCY_MODE` (`multi|single` — same schema; single auto-joins the one tenant) ·
`SIGNUP_MODE` (`open|invite_only|approval`; `BOOTSTRAP_ADMIN_EMAILS` seeds the first admin) ·
`TENANT_SCOPE_MODE` (`off|enforce`, @docs/RLS.md) · `AGENT_MAX_OUTPUT_TOKENS` · `AGENT_MAX_TURNS`.

Rules (auto-loaded by path): @.claude/rules/api.md · database.md · ui.md · cli.md · testing.md ·
code-quality.md · cloudflare.md. Runbooks: @docs/DEPLOY.md · @docs/RLS.md

## Non-Negotiables

- **Gate**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass before every commit
- **Tenant isolation**: every domain query filters by `tenantId` from the auth context; every tenant
  table calls `tenantIsolation()` (RLS inert; `rls-coverage.test.ts` enforces); every cube scopes its
  `sql()` by `tenantIdOf(ctx)` (`cube-isolation.test.ts` is the only enforcement)
- **Contracts first**: zod schema in `packages/shared/src/` → route `validate()` → UI/CLI parse the same
  schema; errors are `{ error, statusCode, code?, details? }`
- **shared is private** — never publish it; never import `apps/web` from `packages/shared` or `apps/cli`
- **Routes enqueue, never run**: long work → `JOBS_QUEUE` or `AGENT_RUN_WORKFLOW`; side effects in
  `waitUntil`; concurrency is a DB claim row, never a `Map`; SSE routes use `streamDatabase(c)`
- **Two tomls, one shape**: bindings, class names, `compatibility_*`, `[limits]`, crons identical in
  `apps/web/wrangler{,.staging}.toml`; account-scoped names differ (parity test)
- **Secrets** never in a toml, git or a response (`hasCredential`); `.dev.vars` comments hold no other
  credentials; the CLI never prints a full key; `gitleaks` in CI
- **No `process.env` / Node-only APIs in `apps/web/src/`** (`pg`, `ws`, `node:fs`…); `build:api` catches it
- **Release = root version**: git tag == root `package.json` `version` (ships web + cli)
- **Docs in sync**: a behaviour change updates CONCEPTS / SETUP / DEPLOY / rules in the same PR
