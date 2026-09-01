# GMGO Starter Kit

Multi-tenant SaaS starter for internal GM apps, a **pnpm workspace**: Hono API + React UI in one
Cloudflare Worker (`apps/web`), a commander CLI (`apps/cli`), private zod contracts
(`packages/shared`). `AGENTS.md` symlinks here.

> **How it works**: @docs/CONCEPTS.md — one section per subsystem with its known gaps. **Check it
> before assuming a capability exists; update it when you change one.**
> **Setup**: @SETUP.md — when asked for setup help, don't summarise: **run Part 1 step by step**,
> show each output, confirm the verification line, stop on failure. Fix missing prerequisites
> (Node via `.nvmrc`, `corepack enable`, Colima if Docker is absent) and carry on.
> **Fresh copy?** @docs/ADAPTING.md first.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat`); one Worker exports `fetch`+`queue`+`scheduled`
  and in-script DO/Workflow classes (`apps/web/src/worker.ts`). Node 24, pnpm 10
- **API**: Hono 4, zod contracts from `@gmgo/shared`, CASL. **DB**: Postgres 17 + pgvector —
  Neon via Hyperdrive deployed, Docker locally; Drizzle over `postgres.js` (only driver), 1 client/request
- **Auth**: arctic (Google, Microsoft) + magic link + dev-login; `__Host-session`; API keys; KV rate limit
- **Async / realtime / AI**: Queues (`JOBS_QUEUE`), `NotificationsHub` DO `/ws`, R2 (`FILES`), cron — built;
  Phase 3: Workflows (`AGENT_RUN_WORKFLOW`), Workers AI → pgvector, Anthropic chat, Langfuse
- **UI**: React 18 + Vite, DaisyUI 5 / Tailwind v4, React Router 6, TanStack Query 5; served as `ASSETS`
- **CLI**: commander + chalk + open; `tsx` in dev, `tsc` → `dist/cli.js` (bin `gmgo`)
- **Tests**: vitest projects `api` · `api-isolated` · `ui` · `config` (web, real Postgres :5433); cli
- **Lint**: Biome 2 at the root (single quotes, `asNeeded` semicolons, 100 cols)

## Commands (all from the workspace root)

```bash
pnpm dev:db:up && pnpm db:migrate  # Postgres :5432; db-roles(role) → migrations → db-roles(grants)
pnpm seed && pnpm dev  # demo tenant/users/key; wrangler dev :3001 + vite :3000
pnpm cli login --server http://localhost:3001  # browser → ~/.gmgo/config.json; then pnpm cli whoami
pnpm test:db:up && pnpm test  # every package; web loads apps/web/.env.test itself
pnpm lint · pnpm typecheck · pnpm build  # whole workspace (biome · wrangler types+tsc · vite+dry-run)
pnpm web <script>  # any apps/web script: test:api, test:config, db:check…
pnpm db:generate · pnpm db:studio · pnpm deploy[:staging] · pnpm provision <staging|production>
```

`wrangler` lives in `apps/web`: `pnpm --filter @gmgo/web exec wrangler …`, never `pnpm exec wrangler`
at the root. No `RESEND_API_KEY` → magic-link URLs are logged; zero credentials locally.

## Architecture

```
apps/web/          @gmgo/web — wrangler*.toml, worker-configuration.d.ts, .dev.vars(.example), .env.test,
│                  docker-compose.*.yml, drizzle.config.ts, migrations/, scripts/, tests/{api,config,ui}
│  src/worker.ts   export default { fetch, queue, scheduled }; export { NotificationsHub } (+AgentRunWorkflow, Phase 3)
│  src/config.ts   loadConfig(env): zod over Cloudflare.Env; routes read c.get('config')
│  src/permissions/  CASL owner/admin/member/support + isGlobalAdmin   src/db/  client, tenant-scope, schema/
│  src/api/        index.ts (Hono app, middleware order, ASSETS catch-all) · queue.ts · scheduled.ts ·
│                  middleware/ · auth/ · routes/ (thin) · services/ (db, cfg, logger) · utils/ ·
│                  queues/ (JOBS_QUEUE consumer, handlers/) · durable-objects/ (NotificationsHub)
│  src/ui/         React app     (per-directory CLAUDE.md in permissions, db/schema, api, ui)
apps/cli/          @gmgo/cli — src/cli.ts, commands/*, api.ts (only fetch site), config.ts, login.ts
packages/shared/   @gmgo/shared — src/*.ts zod contracts, errors, pagination, permissions (CLAUDE.md)
```

**`packages/shared` (contracts first).** Private, no build: `exports` map `@gmgo/shared/<module>` →
`./src/<module>.ts`. A new or changed API surface **starts** with a zod schema there; the route
`validate()`s with it, the UI and the CLI parse responses with it. Imports only `zod`, siblings,
type-only `@casl/ability`.

**`apps/cli`.** `login` opens `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`;
the server mints a tenant API key `cli:<host>` and redirects with `?key=&tenant_id=&tenant_name=`;
stored `0600` in `~/.gmgo/config.json` (`GMGO_API_KEY` / `GMGO_URL` override for CI). `logout`,
`whoami`, `status`, `members|keys|activity list` (`--json`), `config`. Thin `commands/*` over `api.ts`,
exit codes 0/1/2/3 (@.claude/rules/cli.md)

## Config model

`[vars]` in both tomls, read via `loadConfig(env)`: `APP_ENV` (`development|staging|production`) ·
`TENANCY_MODE` (`multi|single` — single hides org switching, auto-joins the one tenant; same schema) ·
`SIGNUP_MODE` (`open|invite_only|approval`, default `invite_only`; `BOOTSTRAP_ADMIN_EMAILS` seeds the
first admin) · `TENANT_SCOPE_MODE` (`off|enforce`, @docs/RLS.md).

Rules (auto-loaded by path): @.claude/rules/api.md · database.md · ui.md · cli.md · testing.md ·
code-quality.md · cloudflare.md. Runbooks: @docs/DEPLOY.md · @docs/RLS.md

## Non-Negotiables

- **Gate**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass before every commit
- **Tenant isolation**: every domain query filters by `tenantId` from the auth context; every tenant
  table calls `tenantIsolation()` (RLS inert; `rls-coverage.test.ts` enforces)
- **Contracts first**: zod schema in `packages/shared/src/` → route `validate()` → UI/CLI parse, same
  schema; errors are `{ error, statusCode, code?, details? }`
- **shared is private** — never add `publishConfig` or publish it; never import `apps/web` from
  `packages/shared` or `apps/cli`
- **Routes enqueue, never run**: long work → `JOBS_QUEUE` or a Workflow; side effects in `waitUntil`;
  concurrency is a DB claim row, never an in-memory `Map`
- **Two tomls, one shape**: bindings, class names, `compatibility_*`, `[limits]`, crons identical in
  `apps/web/wrangler{,.staging}.toml`; account-scoped names differ (`wrangler-parity.test.ts`)
- **Secrets** never in a toml or git; `.dev.vars` comments hold no other credentials; the CLI never
  prints a full key; `gitleaks` runs in CI
- **No `process.env` / Node-only APIs in `apps/web/src/`** (`pg`, `ws`, `node:fs`…); `build:api` catches it
- **Release = root version**: git tag == root `package.json` `version` (one tag ships web + cli)
- **Docs in sync**: a behaviour change updates CONCEPTS / SETUP / DEPLOY / rules in the same PR
