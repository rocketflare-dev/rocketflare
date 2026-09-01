# GMGO Starter Kit

Multi-tenant SaaS starter for internal GM apps, a **pnpm workspace**: Hono API + React UI in one
Cloudflare Worker (`apps/web`), a CLI (`apps/cli`), private zod contracts
(`packages/shared`). `AGENTS.md` symlinks here.

> **How it works**: @docs/CONCEPTS.md — one section per subsystem with its known gaps. **Check it
> before assuming a capability exists; update it when you change one.**
> **Setup**: @SETUP.md — asked for setup help, don't summarise: **run Part 1 step by step**,
> show each output, confirm the verification line, stop on failure; fix missing prerequisites yourself.
> **Fresh copy?** @docs/ADAPTING.md.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat`); one Worker exports `fetch`+`queue`+`scheduled`
  + in-script DO/Workflow classes (`src/worker.ts`). Node 24, pnpm 10
- **API**: Hono 4, zod contracts from `@gmgo/shared`, CASL. **DB**: Postgres 17 + pgvector —
  Neon via Hyperdrive deployed, Docker locally; Drizzle over `postgres.js` (only driver), 1 client/request
- **Auth**: arctic (Google, Microsoft) + magic link + dev-login; `__Host-session`; API keys; KV rate limit
- **Async / realtime**: Queues (`JOBS_QUEUE`), `NotificationsHub` DO `/ws`, R2 (`FILES`), cron, Workflows
- **AI**: `services/ai/resolve` (`agent_models` → tenant `ai_configs` → platform key → 503); Anthropic /
  OpenAI-compatible chat over SSE, agents on `AGENT_RUN_WORKFLOW`, Workers AI → pgvector, Langfuse
- **UI**: React 18 + Vite, DaisyUI 5 / Tailwind v4, React Router 6, TanStack Query 5; served as `ASSETS`
- **CLI**: commander + chalk + open; `tsx` in dev, `tsc` → `dist/cli.js` (bin `gmgo`)
- **Tests**: vitest projects `api` · `api-isolated` · `ui` · `config` (real Postgres :5433); cli
- **Lint**: Biome 2 at the root (single quotes, `asNeeded` semicolons, 100 cols)

## Commands (from the workspace root)

```bash
pnpm dev:db:up && pnpm db:migrate  # Postgres :5432; role → migrations → grants
pnpm seed && pnpm dev  # demo tenant/users/key; wrangler :3001 + vite :3000
pnpm cli login --server http://localhost:3001  # browser → ~/.gmgo/config.json; then pnpm cli whoami
pnpm test:db:up && pnpm test  # every package; web loads its .env.test itself
pnpm lint · pnpm typecheck · pnpm build  # workspace-wide (biome · wrangler types+tsc · vite+dry-run)
pnpm web <script>  # any apps/web script (test:api, db:check…)
pnpm db:generate · pnpm db:studio · pnpm deploy[:staging] · pnpm provision <staging|production>
```

`wrangler` lives in `apps/web`: `pnpm --filter @gmgo/web exec wrangler …`, never `pnpm exec wrangler` at
the root. No `RESEND_API_KEY` → magic-link URLs are logged; no AI key → chat/agents 503; zero creds locally.

## Architecture

```
apps/web/          @gmgo/web — wrangler*.toml, worker-configuration.d.ts, .dev.vars(.example), .env.test,
│                  docker-compose.*.yml, drizzle.config.ts, migrations/, scripts/, tests/
│  src/worker.ts   export default { fetch, queue, scheduled }; export { NotificationsHub, AgentRunWorkflow }
│  src/config.ts   loadConfig(env): zod over Cloudflare.Env; routes read c.get('config')
│  src/permissions/  CASL owner/admin/member/support + isGlobalAdmin   src/db/  client, tenant-scope, schema/
│  src/api/        index.ts (Hono app, middleware order, ASSETS catch-all) · queue.ts · scheduled.ts ·
│                  middleware/ · auth/ · routes/ (thin) · services/ (+ ai/ resolve·kit, agents/, prompts.ts) ·
│                  workflows/ (AgentRunWorkflow) · observability/ (Langfuse Tracer) · utils/ · queues/ · durable-objects/
│  src/ui/         React app     (per-directory CLAUDE.md in permissions, db/schema, api/*, ui)
apps/cli/          @gmgo/cli — src/cli.ts, commands/*, api.ts (only fetch site), config.ts, login.ts
packages/shared/   @gmgo/shared — src/*.ts zod contracts, errors, pagination, permissions (CLAUDE.md)
```

**`packages/shared` (contracts first).** Private, no build: `@gmgo/shared/<module>` → `./src/<module>.ts`
(incl. `ai/*`). A new or changed API surface **starts** with a zod schema there; the route `validate()`s
with it, the UI and the CLI parse with it. Imports only `zod`, siblings, type-only `@casl/ability`.

**`apps/cli`.** `login` opens `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; the server
mints a tenant API key `cli:<host>` and redirects with `?key=&tenant_id=&tenant_name=`; stored `0600` in
`~/.gmgo/config.json` (`GMGO_API_KEY`/`GMGO_URL` for CI). Also `logout|whoami|status|config`,
`members|keys|activity list --json`. Thin `commands/*` over `api.ts` (@.claude/rules/cli.md)

## Config model

`[vars]` in both tomls, read via `loadConfig(env)`: `APP_ENV` (`development|staging|production`) ·
`TENANCY_MODE` (`multi|single` — single hides org switching, auto-joins the one tenant; same schema) ·
`SIGNUP_MODE` (`open|invite_only|approval`; `BOOTSTRAP_ADMIN_EMAILS` seeds the first admin) ·
`TENANT_SCOPE_MODE` (`off|enforce`, @docs/RLS.md) · `AGENT_MAX_OUTPUT_TOKENS` · `AGENT_MAX_TURNS`.

Rules (auto-loaded by path): @.claude/rules/api.md · database.md · ui.md · cli.md · testing.md ·
code-quality.md · cloudflare.md. Runbooks: @docs/DEPLOY.md · @docs/RLS.md

## Non-Negotiables

- **Gate**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass before every commit
- **Tenant isolation**: every domain query filters by `tenantId` from the auth context; every tenant
  table calls `tenantIsolation()` (RLS inert; `rls-coverage.test.ts` enforces)
- **Contracts first**: zod schema in `packages/shared/src/` → route `validate()` → UI/CLI parse the same
  schema; errors are `{ error, statusCode, code?, details? }`
- **shared is private** — never publish it; never import `apps/web` from `packages/shared` or `apps/cli`
- **Routes enqueue, never run**: long work → `JOBS_QUEUE` or `AGENT_RUN_WORKFLOW`; side effects in
  `waitUntil`; concurrency is a DB claim row, never an in-memory `Map`; SSE routes use `streamDatabase(c)`
- **Two tomls, one shape**: bindings, class names, `compatibility_*`, `[limits]`, crons identical in
  `apps/web/wrangler{,.staging}.toml`; account-scoped names differ (parity test)
- **Secrets** never in a toml, git or a response (`hasCredential`); `.dev.vars` comments hold no other
  credentials; the CLI never prints a full key; `gitleaks` runs in CI
- **No `process.env` / Node-only APIs in `apps/web/src/`** (`pg`, `ws`, `node:fs`…); `build:api` catches it
- **Release = root version**: git tag == root `package.json` `version` (ships web + cli)
- **Docs in sync**: a behaviour change updates CONCEPTS / SETUP / DEPLOY / rules in the same PR
