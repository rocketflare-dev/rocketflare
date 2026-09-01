# ADAPTING — you just copied the kit

Read this once, do the checklist, then run `SETUP.md` Part 1. Everything below is a rename or a
delete; no design decisions are needed to get to a running app.

## 0. Copy — decouple from the kit

The kit is a template, not an upstream. Clone it, delete its history, and start your own:

```bash
git clone https://github.com/rocketflare-dev/rocketflare.git myapp && cd myapp
rm -rf .git && git init && git add -A && git commit -m "Start from Rocketflare"
git remote add origin git@github.com:<you>/myapp.git
```

Why: you are about to rename packages, delete examples and rewrite docs; a fork or a shared history
only invites merge conflicts with a kit that will keep evolving independently. If you want to pull a
later kit improvement, cherry-pick or re-apply it by hand from a fresh clone. Record the commit you
started from somewhere (the first commit message is a good place) so you can diff against it later.

## 1. Rename (exact find/replace targets)

Pick an app slug (`myapp`, lowercase, hyphens), a package scope (`@myapp`) and a display name. The
repo is a pnpm workspace (`apps/web`, `apps/cli`, `packages/shared`), so the first block renames the
packages themselves — do it first and run `pnpm install` before anything else, or nothing resolves.

| Token | Where | Replace with |
|---|---|---|
| `@rocketflare/web`, `@rocketflare/cli`, `@rocketflare/shared` | the `name` field of `apps/web/package.json`, `apps/cli/package.json`, `packages/shared/package.json`; every `"@rocketflare/shared": "workspace:*"` dependency; **every import specifier** `@rocketflare/shared/<module>` in `apps/web/src`, `apps/web/tests`, `apps/cli/src` (`grep -rn "@rocketflare/" apps packages --include=*.ts --include=*.tsx --include=*.json -l`); the root `package.json` scripts (`--filter @rocketflare/web`, `--filter @rocketflare/cli`); `.github/workflows/deploy.yml` (`--filter @rocketflare/web`); `CLAUDE.md`, `docs/*.md`, `.claude/rules/*.md` | `@myapp/web`, `@myapp/cli`, `@myapp/shared` — then `pnpm install` (relinks the workspace) |
| `rocketflare` (root package name) | root `package.json` `name` | `myapp` |
| `rocketflare` (API key prefix — keys are `rocketflare_<43 chars>`) | `API_KEY_PREFIX` in `apps/web/src/api/utils/core/hash.ts`; keep `API_KEY_PREFIX_LENGTH` (the stored handle, 20) and `REDACTED_KEY_CHARS` in `apps/cli/src/config.ts` (the CLI's masked form, 16) LONGER than `<prefix>_`, or every key in a list shows zero characters of its token; the `rocketflare_…` literals in `apps/web/tests/{api/keys,api/auth-cli,ui/api-keys}.test.*` and `apps/cli/tests/*` | `myapp` — existing keys keep working (only the display handle changes) |
| `rocketflare` (CLI bin) | `apps/cli/package.json` `bin` key; `program.name('rocketflare')` in `apps/cli/src/cli.ts`; the `pnpm cli` examples in `SETUP.md`, `README.md`, `docs/CONCEPTS.md` | `myapp` — users type `myapp login` |
| `~/.rocketflare` (CLI config dir) | `apps/cli/src/config.ts` (`ROCKETFLARE_CONFIG_DIR` default); `.claude/rules/cli.md`; `SETUP.md` 1.7 | `~/.myapp` |
| `ROCKETFLARE_` (CLI env prefix: `ROCKETFLARE_API_KEY`, `ROCKETFLARE_URL`, `ROCKETFLARE_CONFIG_DIR`, `ROCKETFLARE_DEBUG`) | `apps/cli/src/config.ts`; `apps/cli/tests`; `docs/CONCEPTS.md` → CLI; `.claude/rules/cli.md` | `MYAPP_` |
| `rocketflare` | `apps/web/package.json` `cfld.name`; `apps/web/wrangler.toml` / `wrangler.staging.toml` `name` (staging keeps `-staging`); `apps/web/scripts/cf-provision.sh`; `.claude/rules/cloudflare.md` examples | `myapp` |
| `rocketflare-agent-run` (Workflow — name is account-scoped) | `name = ` in `[[workflows]]` of both tomls (staging `-staging`); no code references — the binding is always `AGENT_RUN_WORKFLOW`, the class `AgentRunWorkflow`; `docs/DEPLOY.md`, `.claude/rules/cloudflare.md`, `apps/web/src/api/workflows/CLAUDE.md` examples | `myapp-agent-run` — nothing to create; `wrangler deploy` registers it |
| `rocketflare-jobs` (queue — name is account-scoped) | `queue = ` in `[[queues.producers]]` AND `[[queues.consumers]]` of both tomls (staging `-staging`; the commented `dead_letter_queue` too); **`JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts`** — the consumer matches `batch.queue` by this prefix, so the toml and the constant must agree or every batch is `ackAll()`ed as "unknown queue"; the literals in `apps/web/tests/api/{queue-dispatch,jobs-producer,jobs-consumer}.test.ts` | `myapp-jobs` — then `wrangler queues create myapp-jobs[-staging]` per environment |
| `rocketflare-files` (R2 bucket — account-scoped) | `bucket_name` in `[[r2_buckets]]` of both tomls (staging `-staging`); no code references — the binding is always `FILES` | `myapp-files` — then `wrangler r2 bucket create myapp-files[-staging]` |
| `rocketflare_dev`, `rocketflare_test`, `rocketflare` / `rocketflare_pass`, `test` / `test` | `apps/web/docker-compose.dev.yml`, `apps/web/docker-compose.test.yml`, `apps/web/.dev.vars.example`, `apps/web/.env.test`, `apps/web/drizzle.config.ts`, `localConnectionString` in both tomls, `.github/workflows/ci.yml` (Postgres service) | `myapp_dev`, `myapp_test`, `myapp` / a local-only password |
| `rocketflare_app` | `apps/web/src/db/schema/rls.ts` `APP_ROLE`, `apps/web/.env.test` `APP_DATABASE_URL`, `docs/RLS.md` | `myapp_app` (policies name the role; do this before the first migration) |
| `Rocketflare` / `Rocketflare Test` | `[vars] APP_NAME` in both tomls, `apps/web/.env.test`, `apps/web/src/ui/index.html` `<title>`, `README.md` | display name |
| `noreply@rocketflare.dev`, `app.rocketflare.dev`, `staging.rocketflare.dev` | `[vars] EMAIL_FROM`, `APP_URL`, commented `routes` in both tomls | your domains |
| `rocketflare-light` / `rocketflare-dark` | `apps/web/src/ui/index.css` theme blocks, `index.html` pre-hydration script, `ThemeToggle.tsx`, `apps/web/tests/ui/theme-toggle.test.tsx` | `myapp-light` / `myapp-dark` (or keep) |
| `rocketflare-dev-postgres` / `rocketflare-test-postgres` | `container_name` in `apps/web/docker-compose.dev.yml` / `docker-compose.test.yml` | `myapp-dev-postgres` / `myapp-test-postgres` — pinned names mean a SECOND checkout of the same kit on one machine fails `pnpm dev:db:up` with "container name already in use" until renamed (the running DB is still reachable) |
| `admin@rocketflare.local` | `apps/web/scripts/seed.ts` (the seeded global admin), the dev quick-login list in `apps/web/src/ui/pages/Login.tsx`, `SETUP.md` | `admin@myapp.local` |
| brand colour variables | the header block of `apps/web/src/ui/index.css` (the only place hex values live) | your palette — then `pnpm web test:ui` (contrast gate) |
| `LogoMark` | `apps/web/src/ui/components/shared/LogoMark.tsx`, `apps/web/src/ui/public/logo.svg` + favicons | your mark |
| `EMBEDDING_DIM` (1024) | `packages/shared/src/ai/config.ts` (imported by `apps/web/src/db/schema/chunks.ts` and the `openai*` embeddings adapter) — only if you will NOT use the default `@cf/baai/bge-m3`; see §3 "Changing the embedding model or dimension" | before the first migration, never after |

Then, from the root: `pnpm install && pnpm types && pnpm lint && pnpm typecheck && pnpm test`. The
parity test will tell you if the two tomls drifted during the rename; `typecheck` will tell you if
an `@rocketflare/shared` import was missed. Keep `packages/shared` **private** (`"private": true`, no
`publishConfig`) whatever you call it.

## 2. Delete once you have real ones

- The example agent `apps/web/src/api/services/agents/examples/summarize-text.ts` (keep
  `services/agents/{registry,runs,runtime}.ts` and `api/workflows/agent-run.ts` — that is the runtime,
  not the example). Removing it touches: `AGENT_KEYS` + `summarizeText*Schema` +
  `SUMMARIZE_TEXT_MAX_CHARS` in `packages/shared/src/ai/agents.ts`, the `summarize-text` entry in
  `PROMPT_REGISTRY` (`apps/web/src/api/services/prompts.ts`), the `AGENTS` entry in
  `services/agents/registry.ts`, `apps/web/tests/api/{agent-runs,agent-run-workflow}.test.ts` (rewrite
  them around your first agent — the runtime needs at least one), and the agent's form/run page under
  `apps/web/src/ui/pages/agents/` (see `apps/web/src/ui/CLAUDE.md`). `AGENT_KEYS` must not be empty:
  `agentKeySchema` is a `z.enum`. Rows in `agent_runs` / `agent_run_events` / `prompt_overrides` /
  `agent_models` for the old key are inert data — delete them or leave them
- The example cubes `ActivityEvents` / `TenantActivityDaily`, the fact table
  `tenant_activity_daily_facts` and the `tenant-overview` template (keep `Users` / `TenantUsers` — they
  document both scoping patterns, and keep `cubes/security.ts`, `routes/cube-api.ts`,
  `services/fact-tables/{refresh,freshness,registry}.ts`, `services/dashboard-templates.ts` — that is
  the runtime). Removing them touches: the two cube files + `allCubes` in `apps/web/src/api/cubes/index.ts`;
  `apps/web/src/db/schema/facts/tenant-activity-daily-facts.ts` (+ `facts/index.ts`, `relations.ts`) with
  a `DROP TABLE` migration; `FACT_TABLES` in `services/fact-tables/registry.ts` and
  `queries/tenant-activity-daily.ts` (an empty registry is fine — the `:15` cron then does nothing; or
  drop the cron from BOTH tomls + `SCHEDULED_TASKS` + `tests/api/scheduled-facts.test.ts`);
  `apps/web/src/dashboards/general-templates/tenant-overview.ts` (+ its `GENERAL_TEMPLATES` entry —
  `DASHBOARD_TEMPLATES` may be empty: `ensureDefaultDashboards` returns 0); and the tests
  `tests/api/cubes/cube-isolation.test.ts` (rewrite the `cases` around your cubes — its coverage
  assertion requires one per cube), `tests/api/services/fact-table-refresh.test.ts`,
  `tests/api/analytics-pages.test.ts` (template expectations), `tests/dashboards/all-templates.test.ts`.
  Existing tenants keep their `tenant-overview` rows as inert `analytics_pages` data (`reset` on them →
  404 `template_not_found`); delete the rows or leave them
- CLI commands you do not want (`apps/cli/src/commands/*` — `members list`, `keys list`,
  `activity list` are examples of the pattern; keep `login`, `logout`, `whoami`, `status`, `config`)
- `docs/analysis/` — the kit's decision record. Keep it until your first release, then move it under
  `docs/archive/` per its README, or delete it. It is not maintained
- Lines in `README.md` "Features" that describe the kit rather than your app

## 3. Your first three features — where each goes

Every feature is the same loop; the rules files load automatically as you touch each layer. The
contract comes first and lives in the shared package so the API, the UI and the CLI parse one schema.

1. **Contract** — `packages/shared/src/<feature>.ts`: zod schemas for the resource, its
   create/update bodies, and list query (`paginationQuerySchema`). Export types with `z.infer`;
   re-export from `packages/shared/src/index.ts`. Consumers import `@rocketflare/shared/<feature>`.
2. **Schema** — `apps/web/src/db/schema/<feature>.ts`: `id`, `...tenantRef()`, columns,
   `...timestamps()`, `tenantIsolation('<table>')` in `extraConfig`; export from `schema/index.ts`;
   `pnpm db:generate`; read the SQL; `pnpm db:migrate`.
3. **Route** — `apps/web/src/api/routes/<feature>.ts` via `createRouter()`, `validate()` with the
   shared schema, `withAuthAndDb`, `guardPermission` with a new CASL subject added in
   `apps/web/src/permissions/abilities.ts`; mount in `api/index.ts` behind `authMiddleware`. Test in
   `apps/web/tests/api/<feature>.test.ts` with the tenant-isolation assertion.
4. **Hook** — `apps/web/src/ui/hooks/use<Feature>.ts`: `queryOptions` + mutations keyed from
   `queryKeys` (`lib/query-keys.ts`). If the server should push changes, have the service
   `nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: '<root>', id }))` — the
   payload names the `queryKeys` family root and needs no new event type — or add a named type to
   `realtimeEventTypeSchema` + `REALTIME_INVALIDATIONS` in `packages/shared/src/realtime.ts`.
5. **Page** — `apps/web/src/ui/pages/<Feature>/…` using `components/shared/` primitives; add to
   `App.tsx` (lazy) and `SideNav` with the same guard the page uses.
6. **Command** (optional) — `apps/cli/src/commands/<feature>.ts`: a thin commander command over
   `apps/cli/src/api.ts`, parsing the response with the same `@rocketflare/shared/<feature>` schema;
   `--json` on every list; exit codes per `.claude/rules/cli.md`. Register it in `cli.ts`.

Long-running work inside a feature: enqueue on `JOBS_QUEUE` (< 30 s) or create a Workflow
instance; never run it in the route.

**Adding an agent** (D7, D17 — `apps/web/src/api/services/agents/CLAUDE.md`). No migration:

1. Contract — `packages/shared/src/ai/agents.ts`: append the key to `AGENT_KEYS`, add
   `<name>InputSchema` / `<name>OutputSchema` (the input is validated at the route AND again before
   `run()`; the output when the run persists it).
2. Prompt — `PROMPT_REGISTRY` in `apps/web/src/api/services/prompts.ts`: `{ key, title, description,
   variables, defaultText }` with `{{var}}` placeholders (`appName`/`tenantName` are pre-filled by the
   runtime; pass the rest through `ctx.prompt({ … })`). It becomes editable in Settings → Prompts and
   assignable in `/api/ai/agent-models` automatically.
3. Definition — `apps/web/src/api/services/agents/examples/<key>.ts` (copy `summarize-text.ts`): `meta`
   (`key`, `title`, `description`, schemas, `promptKey`, `exclusive: true` — every v1 agent is
   exclusive; a non-exclusive one needs `agent_runs_active_exclusive_idx` relaxed) and `run(ctx)`:
   `ctx.step(...)` for coarse stages, `ctx.checkCancelled()` between model turns, `ctx.chat.client`
   with `ctx.chat.model` / `maxOutputTokens` through `callStructuredTool` (one forced tool) or
   `runToolLoop` (read tools + one terminal tool — include `ctx.tools` so the agent can
   `search_knowledge` / `get_document` the tenant's knowledge base), `recordUsage(ctx.db, { feature: 'agent:<key>', … })`
   from `onUsage`, return the output. Never import an SDK or read `ai_configs`.
4. Registry — one entry in `AGENTS` (`services/agents/registry.ts`); `GET /api/agents` lists it.
5. Form/run page — `apps/web/src/ui/pages/agents/…` posting `{ agentKey, input }` to
   `POST /api/agents/runs` (202 → poll/nudge `GET /api/agents/runs/:id` for `events` and `output`);
   guard `create AgentRun`. UI conventions: `apps/web/src/ui/CLAUDE.md`.
6. Tests — `tests/api/agent-runs.test.ts` (enqueue → row + `stubs(env).workflow.created`) and a
   `// @vitest-isolate` runtime test mocking `@/api/services/ai/resolve` with a `FakeChatClient` script
   that answers the terminal tool (`.claude/rules/testing.md`).

**Adding a cube** (D19 — `apps/web/src/api/cubes/CLAUDE.md`). No migration when the table exists:

1. `apps/web/src/api/cubes/<name>.ts`: `defineCube('Name', { sql: ctx => ({ from: table, where:
   eq(table.tenantId, tenantIdOf(ctx)) }), dimensions, measures, joins? })`. **The `where` is the tenant
   predicate and is not optional**; a table without `tenant_id` scopes through membership like
   `users.ts` (`inArray(...)` over a bound `tenant_users` subquery). One `primaryKey: true` dimension;
   joins on the `belongsTo` side only (`targetCube: () => otherCube`); an event table adds
   `meta.eventStream`. Member names are a frozen contract — choose them once.
2. Register it in `allCubes` (`cubes/index.ts`).
3. **Add a case to `apps/web/tests/api/cubes/cube-isolation.test.ts`**: seed rows for its table in
   `seedTenant`, a query and an `expect` per side. The suite fails until every cube in `allCubes` has
   one — that test is the only enforcement of tenant scoping in the cube layer.
4. Optional: portlets in a template (below); the template test then also checks your member names.

**Adding a fact table** (D19 — `apps/web/src/api/services/fact-tables/CLAUDE.md`):

1. Schema — `apps/web/src/db/schema/facts/<name>.ts` (copy `tenant-activity-daily-facts.ts`):
   `tenantRef()`, the grain columns, the measures, `fact_refreshed_at` (`timestamptz`, `defaultNow()`),
   `unique('<name>_grain').on(...)` (`.nullsNotDistinct()` when a grain column is nullable), a
   `(tenant_id, …)` index, `tenantIsolation('<name>')`; no `id`, no `timestamps()`, no FK to `users`.
   Export from `facts/index.ts`; `pnpm db:generate`, read the SQL, `pnpm db:migrate`.
2. Query — `services/fact-tables/queries/<name>.ts`: `export function <name>Select(tenantId: string):
   SQL` — a `sql` tag SELECT with `where tenant_id = ${tenantId}` (bound), columns in the schema file's
   declaration ORDER, ending with `now() as fact_refreshed_at`. The INSERT names its targets from
   `getTableColumns`, so a wrong order fails loudly rather than shifting values.
3. Registry — one entry in `FACT_TABLES` (`registry.ts`): `{ name, table, refreshIntervalMinutes,
   source: { name, table, timestampColumn }, selectForTenant }`. The `:15` cron, `db:refresh-facts`,
   `db:check-facts` and `GET /api/analytics/facts/status` pick it up with no other change. A table
   that needs a different cadence is a second cron entry (both tomls + `SCHEDULED_TASKS`) calling
   `refreshFactTable(db, name)`.
4. Cube — `apps/web/src/api/cubes/<name>.ts` over the table (direct `tenant_id` scoping), + the
   isolation case; `refreshFactTable(db, '<name>', { tenantId })` in `seedTenant` so it has rows.
5. Tests — extend `tests/api/services/fact-table-refresh.test.ts` (one row per grain, idempotent,
   only the refreshed tenant replaced). `pnpm web db:refresh-facts <name> --tenant=<uuid>` for a
   manual run.

**Adding or changing a dashboard template** (D19 — `apps/web/src/dashboards/CLAUDE.md`, read
`DASHBOARD_PATTERNS.md` first; the layout mistakes it lists are silent at runtime):

1. A file under a category folder (`general-templates/`, or a new sibling folder spread into
   `DASHBOARD_TEMPLATES` in `dashboards/index.ts`): a `DashboardConfig` with `layoutMode: 'rows'`,
   explicit `rows` (widths sum to 12), `groups` for KPI strips, one `isUniversalTime` filter,
   portlets whose `query` is `JSON.stringify(<cube query>)` and whose x/y/w/h mirror the rows.
   Templates are pure data — no drizzle or schema imports.
2. The registry entry: `{ key, name, description, order (unique), isDefault? (at most one), config }`.
   `key` is also the page slug.
3. `pnpm web test:config` — `tests/dashboards/all-templates.test.ts` checks the structure and that
   **every `Cube.member` you reference exists in `allCubes`**; the cube isolation test then executes
   every portlet query against Postgres (rows > 0 for a tenant with members and activity — seed
   accordingly).
4. Rollout: a NEW template reaches every tenant on its next `GET /api/analytics/pages` (and new
   tenants at creation). A CHANGED template does **not** — `analytics_pages.config` is a copy. Repair
   per page with `POST /api/analytics/pages/:id/reset` or per tenant with `POST
   /api/analytics/templates/recreate` (`{ created, reset }`; admin+). **Frozen names**: never rename a
   cube member a stored dashboard may reference — add a new one; a rename breaks every saved page in
   every tenant silently, and `reset`/`recreate` is the only way back.

**Renaming or retiming the fact cron.** The expression `15 * * * *` appears in `[triggers] crons` of
BOTH tomls (the parity test compares them), as the key of `SCHEDULED_TASKS` in
`apps/web/src/api/scheduled.ts`, and in `tests/api/scheduled-facts.test.ts`; change all four together.
If you retime it, change `refreshIntervalMinutes` in the registry too — freshness flags `stale` at
2× that interval, so a slower cron with the old interval reports stale between runs. The local trigger
is `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=<expression, + for spaces>"`.

**Adding a chat/embeddings provider** (D17). Append the value to `AI_PROVIDERS` in
`packages/shared/src/ai/config.ts` (LAST — the DB column is a text enum, so no migration; mirror it in
`AI_PROVIDER_VALUES` in `apps/web/src/db/schema/ai-configs.ts`) and a `DEFAULT_MODELS` entry → a
`PROVIDERS` row in `apps/web/src/api/services/ai/providers.ts` (`scopes` = the adapters you ship,
`needsApiKey/BaseUrl`, `supportsThinking/ServiceTier`, presets, suggested models — the settings form
is built from this) → an adapter branch in `services/ai/client.ts` behind `ChatClient` /
`EmbeddingsClient` (`fetch` injectable; normalise every failure with `normalizeAiError`; embeddings
must return `EMBEDDING_DIM`-wide vectors) → a case in `tests/api/ai-client.test.ts` with
`sseResponse()`. A vendor that speaks an existing wire format is NOT a provider: add a
`PROVIDER_PRESETS` entry (base URL + default model) instead. Bedrock recipe (not shipped): a
`bedrock` provider whose adapter signs `POST /model/<id>/invoke` with `aws4fetch` SigV4 (access key +
secret in `apiKeyEnc`, region in `baseUrl`), non-streaming `complete()` and a `stream()` that yields
the finished text in one delta — the AWS event-stream decoder needs Node.

**Changing the embedding model or dimension** (D18). Same width, different model (e.g. an
`openai_compatible` endpoint): a tenant `embeddings` config, or `EMBEDDINGS_API_KEY`; the `openai*`
adapters send `dimensions: EMBEDDING_DIM`, so any model that accepts that parameter fits. A different
width needs a migration: change `EMBEDDING_DIM` in `packages/shared/src/ai/config.ts`, `pnpm
db:generate` (drizzle emits an `ALTER COLUMN … TYPE vector(N)` — on a populated table write it as
`TRUNCATE chunks` + the type change, or a new table, and rebuild the HNSW index), `pnpm db:migrate`,
then re-index every document (`indexDocument` from `documents.content` — a one-off script or a
`document.index` job per row); set the new default in `DEFAULT_MODELS` and the readiness/test
expectations. Do it before the first production migration if you can.

**Adding a job type** (D7): payload schema + a variant in BOTH `jobInputSchema` and
`jobEnvelopeSchema` + the literal in `JOB_TYPES` (`packages/shared/src/jobs.ts`) → a handler
`apps/web/src/api/queues/handlers/<name>.ts` (copy `example-ping.ts`, or `document-index.ts` for one
that re-reads a row by id; signature `(job: JobOf<'x'>,
ctx: { env, config, logger, db })`, throw to retry, return to ack, await everything) → one entry in
the `handlers` table of `apps/web/src/api/queues/jobs.ts` (the `switch` in `runHandler` too) →
callers use `enqueueJob(c.env.JOBS_QUEUE, { type: 'x', payload })` → a case in
`tests/api/jobs-consumer.test.ts`. A breaking payload change is a NEW type (`x.v2`), never an edited
schema — in-flight messages of the old type must still parse.

**Adding a file scope** (D23): add it to `FILE_SCOPES` in `packages/shared/src/files.ts` AND the
mirrored `FILE_SCOPES` in `apps/web/src/db/schema/files.ts` (a `text` enum — no migration for a new
value, but `pnpm db:generate` should produce nothing), then give it a rule in `checkContentType`
in `apps/web/src/api/routes/files.ts` if it needs a MIME allowlist like `avatars`. Per-scope size
limits are an app change (`MAX_UPLOAD_BYTES` is one constant today).

## 3b. Optional add-ons and knobs

- **Heat-map charts**: `@nivo/heatmap` is an optional drizzle-cube peer whose named import breaks the
  Rollup build, so `apps/web/vite.config.ts` aliases it to `apps/web/src/ui/lib/stubs/nivo-heatmap.tsx`
  (renders a notice). To enable: `pnpm --filter @rocketflare/web add @nivo/heatmap`, delete the alias and the
  stub, run `pnpm build:ui`.
- **Dashboard theming**: drizzle-cube reads `--dc-*` CSS variables; the kit maps them to its tokens under
  `:root[data-theme=…]` in `apps/web/src/ui/index.css`. Change the tokens, not the `--dc-*` lines.
- **Removing analytics entirely**: delete `apps/web/src/ui/{pages,components}/analytics`, the three
  analytics hooks, the `/analytics*` routes in `App.tsx`, the nav item, `src/api/cubes`, `src/dashboards`,
  `services/{dashboard-templates.ts,fact-tables}`, `routes/{cube-api,analytics-pages}.ts`, the
  `analytics_pages` / `facts` schema files (+ a migration), the `:15` cron in both tomls, and the
  `drizzle-cube`/`recharts`/`d3`/`react-grid-layout`/`react-is` deps — the Worker bundle drops by ≈ 1 MB gzip.
- **Headless CLI login** (CI, agents, no browser): skip `pnpm cli login`; create a tenant API key in
  Settings → API keys (or `POST /api/keys` with a session cookie) and export `ROCKETFLARE_API_KEY` +
  `ROCKETFLARE_URL`. `pnpm cli whoami` confirms.

## 4. Keep the docs true

`CLAUDE.md` is auto-loaded by every agent session; `docs/CONCEPTS.md` is what it points to for
"does this exist"; `SETUP.md` is what it *runs*. When you add a subsystem, add a CONCEPTS section
with a "Known gaps" list; when you add an env name or a command, update `SETUP.md`,
`apps/web/.dev.vars.example` and the `CLAUDE.md` commands block (and the root `package.json` scripts
if it should be reachable from the root); when you change a convention, edit the
`.claude/rules/*.md` for that layer (`cli.md` for the CLI). The table in `.claude/rules/code-quality.md` is the checklist.
Drift is the one failure mode this kit's source apps suffered most; the rule exists because of it.

## 5. Single-tenant recipe (`TENANCY_MODE=single`)

Many apps — internal tools especially — start as one organisation. Set `TENANCY_MODE = "single"` in both tomls (and
`apps/web/.env.test` if you want the suite to run in that mode). Nothing in the schema changes — every table
keeps `tenant_id` — so flipping back to `multi` later needs no migration. Effects:

- The one tenant is created at bootstrap: `pnpm seed`, or the first verified login of an address in
  `BOOTSTRAP_ADMIN_EMAILS`, who becomes `owner`
- Every user admitted by `SIGNUP_MODE` is auto-joined as `member`; the session always resolves to it
- Hidden/404: `OrgSwitcher`, `/select-tenant`, org create/delete, `/admin/tenants` list (collapses to
  the tenant's detail). Kept: members/roles/invitations, "Workspace settings", `/admin` users and
  access requests, analytics, AI settings
- `apps/web/tests/api/tenancy-single.test.ts` proves the disabled routes 404 and auto-join works
- The CLI's `login` skips tenant selection (the one tenant is implied)

Pair it with `SIGNUP_MODE = "approval"` plus a domain allow-list for "anyone at the company can
request access", or `invite_only` for a closed team.

## 6. If you ever need a Node/Docker target

The kit is Cloudflare-first and ships no Node adapter (locked decision). The recipe if it is ever
required: an `apps/web/src/server.ts` using `@hono/node-server` + `serve-static` for
`apps/web/dist/ui`, a WebSocket
server replacing the Durable Object behind the `Broadcaster` seam in
`apps/web/src/api/services/realtime.ts`, pg-boss or similar behind the `JobsQueue` interface in
`services/jobs.ts` (and a Workflow substitute), a filesystem or S3 `StorageService` in
`services/storage.ts`, and a multi-stage Dockerfile running `db:migrate` then the server. Every seam
named there already exists for that reason.
