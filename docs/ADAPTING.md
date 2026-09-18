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

Or the one-liner — `curl -fsSL https://rocketflare.dev/install.sh | bash -s -- myapp` (read
`scripts/install.sh` first: it clones, detaches exactly as above with the kit commit recorded in the
first message, then execs `scripts/bootstrap.sh`). Either way, `bash scripts/bootstrap.sh` (or
`/rf-setup`) is the first run — `SETUP.md` Part 1 as one command.

Why: you are about to rename packages, delete examples and rewrite docs; a fork or a shared history
only invites merge conflicts with a kit that will keep evolving independently.

**Detached is not frozen.** `.rocketflare.json` at the root records which kit version and commit this
copy came from, and `/rf-adapt` writes your names into it. Later, `/rf-upgrade` (or `pnpm
kit:upgrade`) fetches the kit into a throwaway mirror, translates its diff into your names, drops
everything belonging to a part you deleted, and hands you the rest to apply — guided by the release
notes in `docs/upgrades/`. So delete freely in §2 below: an upgrade never recreates what you removed.

Keep `.rocketflare.json`. Deleting it is the one thing that costs you the upgrade path.

## 1. Rename (exact find/replace targets)

Pick an app slug (`myapp`, lowercase, digits, hyphens; starts with a letter), a package scope
(`@myapp`) and a display name.

**`/rf-adapt <slug> ["Name"] [--domain <apex>] [--colour <#hex>]`** in Claude Code, or by hand
`node scripts/rename.mjs --dry-run <slug> ["Display Name"] [--domain …] [--colour …]` then the same
without `--dry-run`, performs the mechanical rows below in one pass and reports the careful ones —
`.claude/skills/rf-adapt/checklist.md` walks those six, lettered (a)–(f) as in the **Script** column.
The script walks every text file git knows about (tracked and untracked, `.gitignore` honoured;
`pnpm-lock.yaml`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, the two svgs,
the tool itself, its test and the adapt skill are skipped; `github.com/rocketflare-dev/rocketflare`
is preserved as the kit's origin) plus `apps/web/.dev.vars` when it exists (git-ignored, but its
`DATABASE_URL` must follow the compose file), applies nine ordered token classes — `@rocketflare/`
→ `@<slug>/`, `ROCKETFLARE` → `<UPPER>`, `rocketflare.dev|.local` → `<domain>` (default
`<slug>.example.com`), `.rocketflare` → `.<slug>`, the Postgres owner `rocketflare` → `<snake>`,
`rocketflare_` → `<snake>_`, `rocketflare-` → `<slug>-`, `Rocketflare` → the display name, bare
`rocketflare` → `<slug>` — refuses a dirty tree without `--force`, then runs `pnpm install` and
`biome check --write` (`--skip-install` to defer). Exit `0` ok · `1` error · `2` usage. Delete
`apps/web/.provision.json` (the git-ignored provisioning cache) when re-adapting a copy that was
already provisioned — the rename never rewrites it (`.dev.vars` is the only git-ignored file it
opts in), so its cached app name and ids would be the old ones. The table stays the reference — the first block
renames the packages themselves; by hand, do it first and run `pnpm install` before anything else,
or nothing resolves.

| Token | Where | Replace with | Script |
|---|---|---|---|
| `@rocketflare/web`, `@rocketflare/cli`, `@rocketflare/shared` | the `name` field of `apps/web/package.json`, `apps/cli/package.json`, `packages/shared/package.json`; every `"@rocketflare/shared": "workspace:*"` dependency; **every import specifier** `@rocketflare/shared/<module>` in `apps/web/src`, `apps/web/tests`, `apps/cli/src` (`grep -rn "@rocketflare/" apps packages --include=*.ts --include=*.tsx --include=*.json -l`); the root `package.json` scripts (`--filter @rocketflare/web`, `--filter @rocketflare/cli`); `.github/workflows/deploy.yml` (`--filter @rocketflare/web`); `CLAUDE.md`, `docs/*.md`, `.claude/rules/*.md` | `@myapp/web`, `@myapp/cli`, `@myapp/shared` — then `pnpm install` (relinks the workspace) | automatic (`scope`) |
| `rocketflare` (root package name) | root `package.json` `name` | `myapp` | automatic (`bare`) |
| `rocketflare` (API key prefix — keys are `rocketflare_<43 chars>`) | `API_KEY_PREFIX` in `apps/web/src/api/utils/core/hash.ts`; SET `API_KEY_PREFIX_LENGTH` (the stored handle) to `len('<prefix>_') + 8` and `REDACTED_KEY_CHARS` in `apps/cli/src/config.ts` (the CLI's masked form) to `len('<prefix>_') + 4` — shorter and every key in a list shows zero characters of its token; the CLI tests assume exactly prefix + 4; the `rocketflare_…` literals in `apps/web/tests/{api/keys,api/auth-cli,ui/api-keys}.test.*` and `apps/cli/tests/*` | `myapp` — existing keys keep working (only the display handle changes) | automatic — both handles SET to prefix + 8 / prefix + 4, reported as (a) |
| `rocketflare` (CLI bin) | `apps/cli/package.json` `bin` key; `program.name('rocketflare')` in `apps/cli/src/cli.ts`; the `pnpm cli` examples in `SETUP.md`, `README.md`, `docs/CONCEPTS.md` | `myapp` — users type `myapp login` | automatic (`bare`) |
| `~/.rocketflare` (CLI config dir) | `apps/cli/src/config.ts` (`ROCKETFLARE_CONFIG_DIR` default); `.claude/rules/cli.md`; `SETUP.md` 1.7 | `~/.myapp` | automatic (`cfgdir`) |
| `ROCKETFLARE_` (CLI env prefix: `ROCKETFLARE_API_KEY`, `ROCKETFLARE_URL`, `ROCKETFLARE_CONFIG_DIR`, `ROCKETFLARE_DEBUG`) | `apps/cli/src/config.ts`; `apps/cli/tests`; `docs/CONCEPTS.md` → CLI; `.claude/rules/cli.md` | `MYAPP_` | automatic (`env`) |
| `rocketflare` | `apps/web/package.json` `cfld.name`; `apps/web/wrangler.toml` / `wrangler.staging.toml` `name` (staging keeps `-staging`); `apps/web/scripts/cf-provision.sh`; `.claude/rules/cloudflare.md` examples | `myapp` | automatic (`bare` / `kebab`) |
| `rocketflare-agent-run` (Workflow — name is account-scoped) | `name = ` in `[[workflows]]` of both tomls (staging `-staging`); no code references — the binding is always `AGENT_RUN_WORKFLOW`, the class `AgentRunWorkflow`; `docs/DEPLOY.md`, `.claude/rules/cloudflare.md`, `apps/web/src/api/workflows/CLAUDE.md` examples | `myapp-agent-run` — nothing to create; `wrangler deploy` registers it | automatic (`kebab`); the `-staging` suffix reported as (d) |
| `rocketflare-jobs` (queue — name is account-scoped) | `queue = ` in `[[queues.producers]]` AND `[[queues.consumers]]` of both tomls (staging `-staging`; the commented `dead_letter_queue` too); **`JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts`** — the consumer matches `batch.queue` by this prefix, so the toml and the constant must agree or every batch is `ackAll()`ed as "unknown queue"; the literals in `apps/web/tests/api/{queue-dispatch,jobs-producer,jobs-consumer}.test.ts` | `myapp-jobs` — then `wrangler queues create myapp-jobs[-staging]` per environment | automatic (`kebab`, incl. `JOBS_QUEUE_NAME_PREFIX`); reported as (d) |
| `rocketflare-files` (R2 bucket — account-scoped) | `bucket_name` in `[[r2_buckets]]` of both tomls (staging `-staging`); no code references — the binding is always `FILES` | `myapp-files` — then `wrangler r2 bucket create myapp-files[-staging]` | automatic (`kebab`); reported as (d) |
| `rocketflare_dev`, `rocketflare_test`, `rocketflare` / `rocketflare_pass`, `test` / `test` | `apps/web/docker-compose.dev.yml`, `apps/web/docker-compose.test.yml`, `apps/web/.dev.vars.example`, `apps/web/.env.test`, `apps/web/drizzle.config.ts`, `localConnectionString` in both tomls, `.github/workflows/ci.yml` (Postgres service) | `myapp_dev`, `myapp_test`, `myapp` / a local-only password | automatic (`dbuser` + `snake`: the owner stays the snake form — `db-roles.ts` refuses a hyphenated identifier; `.dev.vars` `DATABASE_URL` rewritten when the file exists); reported as (c) |
| `rocketflare_app` | `apps/web/src/db/schema/rls.ts` `APP_ROLE`, `apps/web/.env.test` `APP_DATABASE_URL`, `docs/RLS.md` | `myapp_app` (policies name the role; do this before the first migration) | automatic, including `apps/web/migrations/**` (SQL + meta snapshots) — WARNED as (b): a database migrated under the old name keeps the old role; drop it and migrate again |
| `Rocketflare` / `Rocketflare Test` | `[vars] APP_NAME` in both tomls, `apps/web/.env.test`, `apps/web/src/ui/index.html` `<title>`, `README.md` | display name | automatic (`display`) |
| `noreply@rocketflare.dev`, `app.rocketflare.dev`, `staging.rocketflare.dev` | `[vars] EMAIL_FROM`, `APP_URL`, commented `routes` in both tomls | your domains | automatic (`domain`, from `--domain`) |
| `rocketflare-light` / `rocketflare-dark` | `apps/web/src/ui/index.css` theme blocks, `index.html` pre-hydration script, `ThemeToggle.tsx`, `apps/web/tests/ui/theme-toggle.test.tsx` | `myapp-light` / `myapp-dark` (or keep) | automatic (`kebab`) |
| `rocketflare-dev-postgres` / `rocketflare-test-postgres` | `container_name` in `apps/web/docker-compose.dev.yml` / `docker-compose.test.yml` | `myapp-dev-postgres` / `myapp-test-postgres` — pinned names mean a SECOND checkout of the same kit on one machine shares ONE database (Compose derives the project name `web` from the directory, so `pnpm dev:db:up` attaches to the running container instead of failing; `pnpm bootstrap` detects it and stops unless `--share-db`) until renamed | automatic (`bare`; the `-dev-data` volume too); reported as (c) with the `docker rm` / `volume rm` for the OLD names |
| `admin@rocketflare.local` | `apps/web/scripts/seed.ts` (the seeded global admin), the dev quick-login list in `apps/web/src/ui/pages/Login.tsx`, `SETUP.md` | `admin@myapp.local` | automatic (`domain`) |
| brand colour variables | the header block of `apps/web/src/ui/index.css` (the only place hex values live) | your palette — then `pnpm web test:ui` (contrast gate) | `--colour` rewrites the LIGHT theme's primary hex only (`--color-primary`, `--surface-active`, `--focus-ring`, `--dc-primary-rgb`, `<meta name="theme-color">`); the dark primary, `-content` colours and `--tone-primary-*` tints reported as (e) |
| `LogoMark` | `apps/web/src/ui/components/shared/LogoMark.tsx`, `apps/web/src/ui/public/logo.svg` + favicons | your mark | not touched — reported as (f) |
| `EMBEDDING_DIM` (1024) | `packages/shared/src/ai/config.ts` (imported by `apps/web/src/db/schema/chunks.ts` and the `openai*` embeddings adapter) — only if you will NOT use the default `@cf/baai/bge-m3`; see §3 "Changing the embedding model or dimension" | before the first migration, never after | not touched — the decision is flagged in (b) |

Then, from the root: `pnpm install && pnpm types && pnpm lint && pnpm typecheck && pnpm test`. The
parity test will tell you if the two tomls drifted during the rename; `typecheck` will tell you if
an `@rocketflare/shared` import was missed. Keep `packages/shared` **private** (`"private": true`, no
`publishConfig`) whatever you call it.

## 2. Delete once you have real ones

Each bullet below is a **surface** in `.rocketflare.json`, with an anchor file. Delete the anchor and
`pnpm kit:upgrade` stops offering you that surface's changes forever — no bookkeeping, nothing to
tell it. That is what makes deleting safe.

- The example agents `apps/web/src/api/services/agents/examples/{summarize-text,research-topic}.ts` —
  `summarize-text` is the one-forced-call shape, `research-topic` the tool-loop-over-the-knowledge-base
  shape; delete whichever you are not copying (keep
  `services/agents/{registry,runs,runtime}.ts` and `api/workflows/agent-run.ts` — that is the runtime,
  not the example). Removing it touches: `CORE_AGENT_KEYS` + `summarizeText*Schema` +
  `SUMMARIZE_TEXT_MAX_CHARS` in `packages/shared/src/ai/agents.ts`, the `summarize-text` entry in
  `CORE_PROMPT_REGISTRY` (`apps/web/src/api/services/prompts.ts`), the `CORE_AGENTS` entry in
  `services/agents/registry.ts`, `apps/web/tests/api/{agent-runs,agent-run-workflow,agent-research}.test.ts` (rewrite
  them around your first agent — the runtime needs at least one), and the agent's TWO UI entries —
  `apps/web/src/ui/pages/agents/forms/<key>.tsx` and `outputs/<key>.tsx`, with their registry lines
  (see `apps/web/src/ui/CLAUDE.md`). `RunPage` itself is the runtime's, not the example's. `AGENT_KEYS` must not be empty (it is a `z.enum`, and `CORE_AGENT_KEYS` leads it):
  `agentKeySchema` is a `z.enum`. Rows in `agent_runs` / `agent_run_events` / `prompt_overrides` /
  `agent_models` for the old key are inert data — delete them or leave them
- **Analytics** — it is a PLUGIN (D31, `docs/CONCEPTS.md` §8), so removing it is one command
  rather than a list of files:

  ```bash
  pnpm plugin remove analytics --apply    # three directories, five barrel lines, the surface
  pnpm db:generate --name plugin-analytics-remove && pnpm db:migrate   # read the DROP TABLEs first
  pnpm --dir apps/web remove d3 drizzle-cube react-grid-layout react-is recharts
  ```

  Then the three things a plugin never wrote for you, which the removal plan prints: the
  `15 * * * *` cron out of `[triggers]` in BOTH tomls, `/cubejs-api` and `/mcp` out of
  `[assets] run_worker_first` in both, and the two proxy lines plus the `@nivo/heatmap` alias and
  the `recharts` dedupe entry out of `apps/web/vite.config.ts`. That takes the largest single
  contributor out of the Worker bundle and drizzle-cube out of the UI entirely (`docs/DEPLOY.md`,
  "Bundle size", on why no figure is quoted). To keep analytics but trim ITS examples — the
  `ActivityEvents` / `TenantActivityDaily` cubes, the fact table, the `tenant-overview` template —
  read the plugin's own `CLAUDE.md`; they are its files now, not yours, and `pnpm plugin upgrade`
  will not recreate what you delete
- The reference PLUGIN `example-feature` (D31) — a feature flag, a `example_notes` table, a CRUD
  mount at `/api/example-feature`, `example-feature.ping`, an agent tool, two lifecycle hooks, a
  lazy page with a nav item and two CLI commands, all in three directories. It exists to be read
  first and deleted second — and deleting it is one command:

  ```bash
  pnpm plugin remove example-feature            # read the plan: what is deleted, which barrel
  pnpm plugin remove example-feature --apply    # lines go, which tables db:generate will drop
  pnpm db:generate --name plugin-example-feature-remove   # → DROP TABLE "example_notes"
  pnpm db:migrate
  ```

  It removes the **three directories** (`apps/web/src/plugins/example-feature/`,
  `packages/shared/src/plugins/example-feature/`, `apps/cli/src/plugins/example-feature/`), the
  **five barrel lines** that name them (`apps/web/src/plugins/{server,ui,schema}.ts`,
  `packages/shared/src/plugins/index.ts`, `apps/cli/src/plugins/index.ts` — import and list entry
  both) and its **surface in `.rocketflare.json`**. Nothing else in the kit names it, which is the
  point of the seam. Add `--archive` to copy `example_notes` into schema `archive` first if you
  seeded anything into it you want to keep
- CLI commands you do not want (`apps/cli/src/commands/*` — `members list`, `keys list`,
  `activity list` are examples of the pattern; keep `login`, `logout`, `whoami`, `status`, `config`)
- Lines in `README.md` "Features" that describe the kit rather than your app

## 3. Your first three features — where each goes

**Ask first: is this a feature of YOUR app, or a capability somebody else could install?** (D31,
`docs/CONCEPTS.md` §16.) A plugin is a separate git repository copied into an app — never installed
from npm, exactly like the kit itself — that contributes contracts, schema, routes, jobs, agents,
UI and CLI commands through five barrels it is the only thing allowed to write a line into. Written
as a plugin, a feature is one tree you can lift out, version and install somewhere else; written
into core, it is diffused across twenty files nobody can separate again.

Default to the plugin. **Core is still right when the change is to the kit's OWN tables
(`tenants`, `users`, `tenant_users`, `documents`…), to auth or tenancy, or to a cross-cutting
middleware** — the things a plugin composes ON TOP of and must not redefine. Everything else — a
resource with its own table, its own screens, its own jobs — is a plugin, and
`apps/web/src/plugins/example-feature/` is the worked example of every slot below.

The layer walk is the same either way; what changes is where the line goes. The contract comes
first and lives in the shared package, so the API, the UI and the CLI parse one schema.

| Layer | Core location | The plugin slot |
|---|---|---|
| contract | `packages/shared/src/<feature>.ts` | `packages/shared/src/plugins/<id>/index.ts` |
| job types | `CORE_JOB_VARIANTS` (`shared/src/jobs.ts`) | `SharedPlugin.jobs` |
| CASL subject | `CORE_SUBJECTS` (`shared/src/permissions.ts`) | `SharedPlugin.subjects` + `ServerPlugin.grants` |
| feature flag | `CORE_FEATURES` / `CORE_FEATURE_FLAGS` (`shared/src/features.ts`) | `SharedPlugin.features` |
| `[vars]` | `apps/web/src/config.ts` | `SharedPlugin.config` (a zod raw shape) |
| realtime roots | `REALTIME_INVALIDATIONS` (`shared/src/realtime.ts`) | `SharedPlugin.realtimeRoots` (what `access.changed` invalidates) |
| table | `apps/web/src/db/schema/<feature>.ts` + the barrel | `<id>/db/schema/*` + one `export *` in `plugins/schema.ts` |
| route | `api/routes/<feature>.ts` + the mount table | `ServerPlugin.mounts` (+ `apiPrefixes` for a prefix outside `/api`) |
| job handler | `coreHandlers` (`api/queues/jobs.ts`) | `ServerPlugin.jobHandlers` |
| agent | `CORE_AGENT_KEYS` / `CORE_AGENTS` / `CORE_PROMPT_REGISTRY` | `SharedPlugin.agentKeys` + `ServerPlugin.agents` / `prompts` |
| agent tool | `buildAgentTools` (`services/agents/tools/index.ts`) | `ServerPlugin.agentTools(ctx)` |
| cron | `CORE_SCHEDULED_TASKS` (`api/scheduled.ts`) | `ServerPlugin.scheduledTasks` |
| RLS exclusion / allow-list | `RLS_EXCLUDED_TABLES` / `CORE_UNSCOPED_ALLOWLIST` | `ServerPlugin.rlsExcludedTables` / `unscopedAllowlist` |
| D29 visibility | `VISIBILITY_RESOURCES` (`services/access.ts`) | `ServerPlugin.visibilityResources` |
| new-tenant / demo data | `onTenantCreated` (`utils/db/tenant-helpers.ts`), `scripts/seed.ts` | `ServerPlugin.hooks.onTenantCreated` / `hooks.seedDemo` |
| page + route | `App.tsx` (lazy) | `UiPlugin.routes` (always `lazy()`) |
| nav item | `CORE_NAVIGATION` (`SideNav.tsx`) | `UiPlugin.nav` (a group placed `before` a core one) |
| settings tab | `SettingsLayout.tsx` | `UiPlugin.settingsTabs(ctx)` |
| query keys | `CORE_QUERY_KEYS` (`lib/query-keys.ts`) | `UiPlugin.queryKeys` (roots `<id>:…`) |
| agent form | `CORE_AGENT_FORMS` (`pages/agents/forms/index.ts`) | `UiPlugin.agentForms` |
| CLI command | `apps/cli/src/commands/<feature>.ts` + `cli.ts` | `CliPlugin.register(program, action)` |

Written into core, the loop is:

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

Written as a plugin, the same six steps land in the four published files instead — the shared
entry (1, and every key the plugin owns), the server entry (2, 3), the UI entry (4, 5) and the CLI
entry (6) — and the host merges each contribution into the registry it could not otherwise be
edited into. Everything the plugin keys carries its id: tables prefixed from it
(`example-feature` → `example_*`), job types `<id>.verb`,
the API prefix `/api/<id>`, query-key roots `<id>:…`, the CLI command `<id>`, AG-UI CUSTOM events
`<id>.` (**never `kit.`**). Read `apps/web/src/plugins/CLAUDE.md` for the seam and
`apps/web/src/plugins/example-feature/CLAUDE.md` for the example, and remember the two things a
plugin never does: **it ships no migration** (the HOST runs `pnpm db:generate --name
plugin-<id>-<version>` once its schema barrel line is in place) and **it edits no toml** (a binding,
cron, route prefix or `[vars]` key it declares in `plugin.json` is written into BOTH files by
`pnpm provision cloudflare <env>`; a `secret: true` var goes in through `provision secrets <env>`).

Long-running work inside a feature: enqueue on `JOBS_QUEUE` (< 30 s) or create a Workflow
instance; never run it in the route.

**Correcting model prices** (D18). `packages/shared/src/ai/pricing.ts` is the only place rates
live: edit `MODEL_PRICES` (USD per million tokens; keys are model-id prefixes, longest match wins),
bump `PRICES_UPDATED`, done — new rows price from it at write time, older rows are priced on read.
A model you leave out shows "—" on Settings → Usage rather than a wrong number.

**Adding an agent** (D7, D17 — `apps/web/src/api/services/agents/CLAUDE.md`). No migration:

1. Contract — `packages/shared/src/ai/agents.ts`: append the key to `CORE_AGENT_KEYS`, add
   `<name>InputSchema` / `<name>OutputSchema` (the input is validated at the route AND again before
   `run()`; the output when the run persists it).
2. Prompt — `CORE_PROMPT_REGISTRY` in `apps/web/src/api/services/prompts.ts`: `{ key, title, description,
   variables, defaultText }` with `{{var}}` placeholders (`appName`/`tenantName` are pre-filled by the
   runtime; pass the rest through `ctx.prompt({ … })`). It becomes editable in Settings → Prompts and
   assignable in `/api/ai/agent-models` automatically.
3. Definition — `apps/web/src/api/services/agents/examples/<key>.ts` (copy `summarize-text.ts`): `meta`
   (`key`, `title`, `description`, schemas, `promptKey`, `exclusive: true` — every v1 agent is
   exclusive; a non-exclusive one needs `agent_runs_active_exclusive_idx` relaxed — plus
   `approvers`, `'requester'` by default, `'admin'` when only an admin may answer this agent's
   questions) and `run(ctx)`:
   `ctx.step(...)` for coarse stages, `ctx.checkCancelled()` between model turns, `ctx.chat.client`
   with `ctx.chat.model` / `maxOutputTokens` through `callStructuredTool` (one forced tool) or
   `runToolLoop` (read tools + one terminal tool — include `ctx.tools` so the agent can
   `search_knowledge` / `get_document` the tenant's knowledge base), `recordUsage(ctx.db, { feature: 'agent:<key>', … })`
   from `onUsage`, return the output. Never import an SDK or read `ai_configs`.
   **If it does anything consequential, ask first** (issue #17, `docs/CONCEPTS.md` §9):
   `await ctx.interrupt({ key, spec })` for something the AGENT decided to do (`summarize-text`), or
   `Tool.requiresApproval` / `requiresApprovalWhen(input)` for something the MODEL decided to call
   (`research-topic`). The `key` must be stable across attempts — `UNIQUE (run_id, key)` is what
   makes the resumed run find the answer instead of asking again — everything after an interrupt
   goes behind `ctx.once` because it is on the far side of a park that may last days, and a
   `runToolLoop` agent with a gated tool MUST pass `approvals: ctx.approvals` and
   `runApproved: ctx.once` or the gate is re-asked and the approved call runs twice. Record what the
   run produced with `ctx.artifact({ key, title, data })`, and read what a person typed at it with
   `ctx.steering()` inside `beforeTurn`.
4. Registry — one entry in `CORE_AGENTS` (`services/agents/registry.ts`); `GET /api/agents` lists
   it. In a plugin it is `ServerPlugin.agents` instead, checked for exhaustiveness against the keys
   that plugin's `SharedPlugin.agentKeys` declared.
5. UI — **an agent in this kit is one shared input schema + one `forms/` entry + one `outputs/`
   entry.** There is no per-agent run page to write: `RunPage` is generic, and it renders the
   timeline, the interrupt panel, the steering composer and the artifacts for every agent. Add
   `apps/web/src/ui/pages/agents/forms/<key>.tsx` to `CORE_AGENT_FORMS` (skip it and the page generates a
   form from your input JSON Schema, or falls back to a JSON textarea) and
   `outputs/<key>.tsx` to `AGENT_OUTPUTS` for how the answer renders. Guards: `create AgentRun` to
   start one, `update AgentRun` plus the agent's `approvers` to answer a question. UI conventions:
   `apps/web/src/ui/CLAUDE.md`.
6. Tests — `tests/api/agent-runs.test.ts` (enqueue → row + `stubs(env).workflow.created`) and a
   `// @vitest-isolate` runtime test mocking `@/api/services/ai/resolve` with a `FakeChatClient` script
   that answers the terminal tool (`.claude/rules/testing.md`). An agent that interrupts needs one
   more: park it, answer it, re-enter `execute` and assert there is still exactly ONE interrupt row
   and one copy of whatever it wrote — `tests/api/agent-research.test.ts` is the template, and
   `createFakeWorkflowStep({ onWait })` is how a test stands in for a person clicking Approve.

**Adding a cube, a fact table or a dashboard template** (D19) — all three belong to the ANALYTICS
PLUGIN now, and the instructions live with the code: `apps/web/src/plugins/analytics/CLAUDE.md`,
`cubes/CLAUDE.md`, `services/fact-tables/CLAUDE.md` and `dashboards/DASHBOARD_PATTERNS.md`, once
the plugin is installed. Two things are worth knowing before you open them.

**Where your code goes depends on whose feature it is.** A cube over YOUR tables, in an app you own,
goes inside the plugin's tree like any other file you have adopted — it is ordinary source in your
repository. A cube that belongs to a SECOND plugin goes through the extension seam instead
(D31 decision 6), because one plugin may not reach into another's internals:

```ts
import { analyticsExtensions } from '@/plugins/analytics'

export const ordersServer = {
  shared: ordersShared,
  extensions: analyticsExtensions({
    cubes: [ordersCube],
    factTables: [ordersDailyFacts],
    dashboardTemplates: [ordersOverview],
    cubeIsolationCases: [ordersIsolationCase],
  }),
} satisfies ServerPlugin<typeof ordersShared>
```

with `requires: { plugins: ['analytics'] }` in your `plugin.json`, so installing without it is
refused rather than quietly doing nothing. Each list is zod-narrowed by the analytics plugin and
**throws naming your plugin** when it cannot be parsed.

**The one rule that has no second line of defence** is unchanged wherever the cube lives: its `sql()`
scopes by `tenantIdOf(ctx)`, and it is not done until it has a case in `cube-isolation.test.ts` —
whose coverage assertion walks the whole registry, contributed cubes included, so a cube with no
case fails your gate. Member names are a frozen contract: stored dashboards reference
`Cube.measure` strings in jsonb, so add members, never rename them.

**Renaming or retiming the fact cron.** The expression `15 * * * *` is the analytics plugin's
declaration, and it has to agree in three places: `crons` in its `plugin.json`, `[triggers] crons`
in BOTH tomls (the parity test compares the two files to each other, not to the plugin), and the
key of `ServerPlugin.scheduledTasks`. **A task registered under an expression no toml declares
simply never runs, and nothing says so.** If you retime it, change `refreshIntervalMinutes` in the
fact-table registry too — freshness flags `stale` at 2× that interval, so a slower cron with the
old interval reports stale between runs. Local trigger:
`curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=<expression, + for spaces>"`.

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

**Adding a job type** (D7): payload schema + ONE variant in `CORE_JOB_VARIANTS`
(`packages/shared/src/jobs.ts` — both unions, `JobType` and `JOB_TYPES` are derived from that list)
→ a handler
`apps/web/src/api/queues/handlers/<name>.ts` (copy `document-index.ts` for one that re-reads a row
by id, or `src/plugins/example-feature/jobs/ping.ts` for the shortest one there is; signature
`(job: JobOf<'x'>,
ctx: { env, config, logger, db })`, throw to retry, return to ack, await everything) → one entry in
`coreHandlers` in `apps/web/src/api/queues/jobs.ts` (its mapped type is the completeness check;
there is no `runHandler` switch to update) →
callers use `enqueueJob(c.env.JOBS_QUEUE, { type: 'x', payload })` → a case in
`tests/api/jobs-consumer.test.ts`. A breaking payload change is a NEW type (`x.v2`), never an edited
schema — in-flight messages of the old type must still parse. In a plugin it is `SharedPlugin.jobs`
(namespace the `type` with the plugin's id) and `ServerPlugin.jobHandlers`, which is checked to
cover exactly the variants that plugin declared.

**Adding a file scope** (D23): add it to `FILE_SCOPES` in `packages/shared/src/files.ts` AND the
mirrored `FILE_SCOPES` in `apps/web/src/db/schema/files.ts` (a `text` enum — no migration for a new
value, but `pnpm db:generate` should produce nothing), then give it a rule in `checkContentType`
in `apps/web/src/api/routes/files.ts` if it needs a MIME allowlist like `avatars`. Per-scope size
limits are an app change (`MAX_UPLOAD_BYTES` is one constant today).

## 3b. Optional add-ons and knobs

- **Analytics add-ons** — all of these need the analytics plugin installed, and all of them live in
  its tree. **Heat-map charts**: `@nivo/heatmap` is an optional drizzle-cube peer whose named import
  breaks the Rollup build, so `apps/web/vite.config.ts` aliases it to the plugin's own
  `ui/lib/nivo-heatmap.tsx` stub (which renders a notice). To enable it:
  `pnpm --filter @rocketflare/web add @nivo/heatmap`, delete the alias and the stub, `pnpm build:ui`.
  **Dashboard theming**: drizzle-cube reads `--dc-*` CSS variables, mapped to the kit's tokens in
  the plugin's `ui/drizzle-cube-theme.css` — which is imported beside the library's own stylesheet
  so it ships only in the lazy analytics chunk. Change the kit's tokens, not the `--dc-*` lines.
  **Removing analytics entirely** is `pnpm plugin remove analytics --apply` (§2 above).
- **Your own streamed events (AG-UI)**: chat and agent runs speak AG-UI
  (`docs/CONCEPTS.md` §9). A new semantic is either an AG-UI event type added to
  `kitAguiEventSchema` or — far more often — a CUSTOM event. **Put yours in your OWN namespace,
  never `kit.`**: `KIT_CUSTOM_EVENTS` is the kit's and a later release may add to it, so an
  `orders.` or `acme.` prefix is what keeps an upgrade from colliding with you. Add the name and its
  zod payload beside `kitCustomPayloadSchema` in `packages/shared/src/ai/agui.ts`, emit it with
  `kitCustom`-style builders from `services/ai/agui.ts`, and remember a third-party AG-UI client
  ignores CUSTOM events for free — which is the point.
- **Turning chat's knowledge tools off**: `CHAT_KNOWLEDGE_TOOLS = "false"` in BOTH wrangler tomls
  (the parity test compares `[vars]` keys, so it has to be in both either way). Tool-free chat is
  cheaper per turn and streams token by token on every provider.
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
