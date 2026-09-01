# ADAPTING — you just copied the kit

Read this once, do the checklist, then run `SETUP.md` Part 1. Everything below is a rename or a
delete; no design decisions are needed to get to a running app.

## 1. Rename (exact find/replace targets)

Pick an app slug (`myapp`, lowercase, hyphens), a package scope (`@myapp`) and a display name. The
repo is a pnpm workspace (`apps/web`, `apps/cli`, `packages/shared`), so the first block renames the
packages themselves — do it first and run `pnpm install` before anything else, or nothing resolves.

| Token | Where | Replace with |
|---|---|---|
| `@gmgo/web`, `@gmgo/cli`, `@gmgo/shared` | the `name` field of `apps/web/package.json`, `apps/cli/package.json`, `packages/shared/package.json`; every `"@gmgo/shared": "workspace:*"` dependency; **every import specifier** `@gmgo/shared/<module>` in `apps/web/src`, `apps/web/tests`, `apps/cli/src` (`grep -rn "@gmgo/" apps packages --include=*.ts --include=*.tsx --include=*.json -l`); the root `package.json` scripts (`--filter @gmgo/web`, `--filter @gmgo/cli`); `.github/workflows/deploy.yml` (`--filter @gmgo/web`); `CLAUDE.md`, `docs/*.md`, `.claude/rules/*.md` | `@myapp/web`, `@myapp/cli`, `@myapp/shared` — then `pnpm install` (relinks the workspace) |
| `gmgo` (root package name) | root `package.json` `name` | `myapp` |
| `gmgo` (CLI bin) | `apps/cli/package.json` `bin` key; `program.name('gmgo')` in `apps/cli/src/cli.ts`; the `pnpm cli` examples in `SETUP.md`, `README.md`, `docs/CONCEPTS.md` | `myapp` — users type `myapp login` |
| `~/.gmgo` (CLI config dir) | `apps/cli/src/config.ts` (`GMGO_CONFIG_DIR` default); `.claude/rules/cli.md`; `SETUP.md` 1.7 | `~/.myapp` |
| `GMGO_` (CLI env prefix: `GMGO_API_KEY`, `GMGO_URL`, `GMGO_CONFIG_DIR`, `GMGO_DEBUG`) | `apps/cli/src/config.ts`; `apps/cli/tests`; `docs/CONCEPTS.md` → CLI; `.claude/rules/cli.md` | `MYAPP_` |
| `gmgo-starter` | `apps/web/package.json` `cfld.name`; `apps/web/wrangler.toml` / `wrangler.staging.toml` `name` (staging keeps `-staging`); `apps/web/scripts/cf-provision.sh`; the Phase 3 Workflow name (`gmgo-starter-agent-run`); `.claude/rules/cloudflare.md` examples | `myapp` |
| `gmgo-starter-jobs` (queue — name is account-scoped) | `queue = ` in `[[queues.producers]]` AND `[[queues.consumers]]` of both tomls (staging `-staging`; the commented `dead_letter_queue` too); **`JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts`** — the consumer matches `batch.queue` by this prefix, so the toml and the constant must agree or every batch is `ackAll()`ed as "unknown queue"; the literals in `apps/web/tests/api/{queue-dispatch,jobs-producer,jobs-consumer}.test.ts` | `myapp-jobs` — then `wrangler queues create myapp-jobs[-staging]` per environment |
| `gmgo-starter-files` (R2 bucket — account-scoped) | `bucket_name` in `[[r2_buckets]]` of both tomls (staging `-staging`); no code references — the binding is always `FILES` | `myapp-files` — then `wrangler r2 bucket create myapp-files[-staging]` |
| `gmgo_dev`, `gmgo_test`, `gmgo` / `gmgo_pass`, `test` / `test` | `apps/web/docker-compose.dev.yml`, `apps/web/docker-compose.test.yml`, `apps/web/.dev.vars.example`, `apps/web/.env.test`, `apps/web/drizzle.config.ts`, `localConnectionString` in both tomls, `.github/workflows/ci.yml` (Postgres service) | `myapp_dev`, `myapp_test`, `myapp` / a local-only password |
| `gmgo_app` | `apps/web/src/db/schema/rls.ts` `APP_ROLE`, `apps/web/.env.test` `APP_DATABASE_URL`, `docs/RLS.md` | `myapp_app` (policies name the role; do this before the first migration) |
| `GMGO Starter` / `GMGO Test` | `[vars] APP_NAME` in both tomls, `apps/web/.env.test`, `apps/web/src/ui/index.html` `<title>`, `README.md` | display name |
| `noreply@example.com`, `app.example.com`, `staging.example.com` | `[vars] EMAIL_FROM`, `APP_URL`, commented `routes` in both tomls | your domains |
| `gm-light` / `gm-dark` | `apps/web/src/ui/index.css` theme blocks, `index.html` pre-hydration script, `ThemeToggle.tsx`, `apps/web/tests/ui/contrast.test.ts` | `myapp-light` / `myapp-dark` (or keep) |
| brand colour variables | the header block of `apps/web/src/ui/index.css` (the only place hex values live) | your palette — then `pnpm web test:ui` (contrast gate) |
| `LogoMark` | `apps/web/src/ui/components/shared/LogoMark.tsx`, `apps/web/src/ui/public/logo.svg` + favicons | your mark |
| `EMBEDDING_DIM` (1024) | `apps/web/src/db/schema/_helpers.ts` — only if you will NOT use the default `@cf/baai/bge-m3` | before the first migration, never after |

Then, from the root: `pnpm install && pnpm types && pnpm lint && pnpm typecheck && pnpm test`. The
parity test will tell you if the two tomls drifted during the rename; `typecheck` will tell you if
an `@gmgo/shared` import was missed. Keep `packages/shared` **private** (`"private": true`, no
`publishConfig`) whatever you call it.

## 2. Delete once you have real ones

- The example agent `apps/web/src/api/services/agents/examples/summarize-text.ts` + its tests and
  runs page entry (keep `services/agents/runtime.ts` — that is the runtime, not the example)
- The example cubes `ActivityEvents` / `TenantActivityDaily` and the `tenant_activity_daily_facts`
  table + `tenant-overview` template (keep `Users` / `TenantUsers` — they document both scoping
  patterns). Update `apps/web/src/api/services/fact-tables/registry.ts` and
  `apps/web/tests/dashboards/all-templates.test.ts`
- CLI commands you do not want (`apps/cli/src/commands/*` — `members list`, `keys list`,
  `activity list` are examples of the pattern; keep `login`, `logout`, `whoami`, `status`, `config`)
- `docs/analysis/` — the kit's decision record. Keep it until your first release, then move it under
  `docs/archive/` per its README, or delete it. It is not maintained
- Rows in `README.md` "What's included" that describe the kit rather than your app

## 3. Your first three features — where each goes

Every feature is the same loop; the rules files load automatically as you touch each layer. The
contract comes first and lives in the shared package so the API, the UI and the CLI parse one schema.

1. **Contract** — `packages/shared/src/<feature>.ts`: zod schemas for the resource, its
   create/update bodies, and list query (`paginationQuerySchema`). Export types with `z.infer`;
   re-export from `packages/shared/src/index.ts`. Consumers import `@gmgo/shared/<feature>`.
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
   `apps/cli/src/api.ts`, parsing the response with the same `@gmgo/shared/<feature>` schema;
   `--json` on every list; exit codes per `.claude/rules/cli.md`. Register it in `cli.ts`.

Long-running work inside a feature: enqueue on `JOBS_QUEUE` (< 30 s) or create a Workflow
instance; never run it in the route.

**Adding a job type** (D7): payload schema + a variant in BOTH `jobInputSchema` and
`jobEnvelopeSchema` + the literal in `JOB_TYPES` (`packages/shared/src/jobs.ts`) → a handler
`apps/web/src/api/queues/handlers/<name>.ts` (copy `example-ping.ts`; signature `(job: JobOf<'x'>,
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

## 4. Keep the docs true

`CLAUDE.md` is auto-loaded by every agent session; `docs/CONCEPTS.md` is what it points to for
"does this exist"; `SETUP.md` is what it *runs*. When you add a subsystem, add a CONCEPTS section
with a "Known gaps" list; when you add an env name or a command, update `SETUP.md`,
`apps/web/.dev.vars.example` and the `CLAUDE.md` commands block (and the root `package.json` scripts
if it should be reachable from the root); when you change a convention, edit the
`.claude/rules/*.md` for that layer (`cli.md` for the CLI). The table in `.claude/rules/code-quality.md` is the checklist.
Drift is the one failure mode this kit's source apps suffered most; the rule exists because of it.

## 5. Single-tenant recipe (`TENANCY_MODE=single`)

Most internal tools start as one organisation. Set `TENANCY_MODE = "single"` in both tomls (and
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
