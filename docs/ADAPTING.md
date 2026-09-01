# ADAPTING — you just copied the kit

Read this once, do the checklist, then run `SETUP.md` Part 1. Everything below is a rename or a
delete; no design decisions are needed to get to a running app.

## 1. Rename (exact find/replace targets)

Pick an app slug (`myapp`, lowercase, hyphens) and a display name. Then:

| Token | Where | Replace with |
|---|---|---|
| `gmgo-starter` | `package.json` `name` + `cfld.name`; `wrangler.toml` / `wrangler.staging.toml` `name` (staging keeps `-staging`); later-phase queue / R2 / Workflow names (`gmgo-starter-jobs`, `gmgo-starter-files`, `gmgo-starter-agent-run`); `.claude/rules/cloudflare.md` examples | `myapp` |
| `gmgo_dev`, `gmgo_test`, `gmgo` / `gmgo_pass`, `test` / `test` | `docker-compose.dev.yml`, `docker-compose.test.yml`, `.dev.vars.example`, `.env.test`, `drizzle.config.ts`, `localConnectionString` in both tomls, `.github/workflows/ci.yml` (Postgres service) | `myapp_dev`, `myapp_test`, `myapp` / a local-only password |
| `gmgo_app` | `src/db/schema/rls.ts` `APP_ROLE`, `.env.test` `APP_DATABASE_URL`, `docs/RLS.md` | `myapp_app` (policies name the role; do this before the first migration) |
| `GMGO Starter` / `GMGO Test` | `[vars] APP_NAME` in both tomls, `.env.test`, `src/ui/index.html` `<title>`, `README.md` | display name |
| `noreply@example.com`, `app.example.com`, `staging.example.com` | `[vars] EMAIL_FROM`, `APP_URL`, commented `routes` in both tomls | your domains |
| `gm-light` / `gm-dark` | `src/ui/index.css` theme blocks, `index.html` pre-hydration script, `ThemeToggle.tsx`, `tests/ui/contrast.test.ts` | `myapp-light` / `myapp-dark` (or keep) |
| brand colour variables | the header block of `src/ui/index.css` (the only place hex values live) | your palette — then `pnpm test:ui` (contrast gate) |
| `LogoMark` | `src/ui/components/shared/LogoMark.tsx`, `src/ui/public/logo.svg` + favicons | your mark |
| `EMBEDDING_DIM` (1024) | `src/db/schema/_helpers.ts` — only if you will NOT use the default `@cf/baai/bge-m3` | before the first migration, never after |

Then: `pnpm types && pnpm lint && pnpm typecheck && pnpm test`. The parity test will tell you if the
two tomls drifted during the rename.

## 2. Delete once you have real ones

- The example agent `src/api/services/agents/examples/summarize-text.ts` + its tests and runs page
  entry (keep `services/agents/runtime.ts` — that is the runtime, not the example)
- The example cubes `ActivityEvents` / `TenantActivityDaily` and the `tenant_activity_daily_facts`
  table + `tenant-overview` template (keep `Users` / `TenantUsers` — they document both scoping
  patterns). Update `src/api/services/fact-tables/registry.ts` and `tests/dashboards/all-templates.test.ts`
- `docs/analysis/` — the kit's decision record. Keep it until your first release, then move it under
  `docs/archive/` per its README, or delete it. It is not maintained
- Rows in `README.md` "What's included" that describe the kit rather than your app

## 3. Your first three features — where each goes

Every feature is the same loop; the rules files load automatically as you touch each layer.

1. **Contract** — `src/shared/<feature>.ts`: zod schemas for the resource, its create/update
   bodies, and list query (`paginationQuerySchema`). Export types with `z.infer`.
2. **Schema** — `src/db/schema/<feature>.ts`: `id`, `...tenantRef()`, columns, `...timestamps()`,
   `tenantIsolation('<table>')` in `extraConfig`; export from `schema/index.ts`; `pnpm db:generate`;
   read the SQL; `pnpm db:migrate`.
3. **Route** — `src/api/routes/<feature>.ts` via `createRouter()`, `validate()` with the shared
   schema, `withAuthAndDb`, `guardPermission` with a new CASL subject added in
   `src/permissions/abilities.ts`; mount in `api/index.ts` behind `authMiddleware`. Test in
   `tests/api/<feature>.test.ts` with the tenant-isolation assertion.
4. **Hook** — `src/ui/hooks/use<Feature>.ts`: `queryOptions` + mutations keyed from `queryKeys`
   (`lib/query-keys.ts`);
   add the entity to the websocket `entityInvalidations` map if the server broadcasts it.
5. **Page** — `src/ui/pages/<Feature>/…` using `components/shared/` primitives; add to `App.tsx`
   (lazy) and `SideNav` with the same guard the page uses.

Long-running work inside a feature: enqueue on `JOBS_QUEUE` (< 30 s) or create a Workflow
instance; never run it in the route.

## 4. Keep the docs true

`CLAUDE.md` is auto-loaded by every agent session; `docs/CONCEPTS.md` is what it points to for
"does this exist"; `SETUP.md` is what it *runs*. When you add a subsystem, add a CONCEPTS section
with a "Known gaps" list; when you add an env name or a command, update `SETUP.md`,
`.dev.vars.example` and the `CLAUDE.md` commands block; when you change a convention, edit the
`.claude/rules/*.md` for that layer. The table in `.claude/rules/code-quality.md` is the checklist.
Drift is the one failure mode this kit's source apps suffered most; the rule exists because of it.

## 5. Single-tenant recipe (`TENANCY_MODE=single`)

Most internal tools start as one organisation. Set `TENANCY_MODE = "single"` in both tomls (and
`.env.test` if you want the suite to run in that mode). Nothing in the schema changes — every table
keeps `tenant_id` — so flipping back to `multi` later needs no migration. Effects:

- The one tenant is created at bootstrap: `pnpm seed`, or the first verified login of an address in
  `BOOTSTRAP_ADMIN_EMAILS`, who becomes `owner`
- Every user admitted by `SIGNUP_MODE` is auto-joined as `member`; the session always resolves to it
- Hidden/404: `OrgSwitcher`, `/select-tenant`, org create/delete, `/admin/tenants` list (collapses to
  the tenant's detail). Kept: members/roles/invitations, "Workspace settings", `/admin` users and
  access requests, analytics, AI settings
- `tests/api/tenancy-single.test.ts` proves the disabled routes 404 and auto-join works

Pair it with `SIGNUP_MODE = "approval"` plus a domain allow-list for "anyone at the company can
request access", or `invite_only` for a closed team.

## 6. If you ever need a Node/Docker target

The kit is Cloudflare-first and ships no Node adapter (locked decision). The recipe if it is ever
required: a `src/server.ts` using `@hono/node-server` + `serve-static` for `dist/ui`, a WebSocket
server replacing the Durable Object behind the `NotificationService` seam, pg-boss or similar
replacing Queues/Workflows behind the producer helpers, and a multi-stage Dockerfile running
`db:migrate` then the server. Every seam named there already exists for that reason.
