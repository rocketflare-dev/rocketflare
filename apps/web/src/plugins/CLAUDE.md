# The plugin seam

A plugin is a **git repository copied into an app**, never an npm package; this is the contract for
writing one. Design: `docs/CONCEPTS.md` §16 · importable symbols: `docs/plugin-api.md` · example:
`example-feature/` · **`/rf-plugin`** for anything procedural (add, upgrade, remove, `check`).

The seam is **six barrel lines** — install writes them, remove deletes them; nothing else in the
host ever names a plugin.

| Barrel | Exports | Read by |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS` / `sharedPlugins` | the five composers (`ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts`), `config.ts`, `prompts.ts` |
| `server.ts` | `SERVER_PLUGINS` / `serverPlugins` | each registry it feeds (grep `serverPlugins`) — never `db/schema/rls.ts` (a cycle) |
| `ui.ts` | `UI_PLUGINS` / `uiPlugins` | `App.tsx`, `SideNav.tsx`, `SettingsLayout.tsx`, `Home.tsx`, `lib/query-keys.ts`, `agents/forms/index.ts` |
| `schema.ts` | one `export *` per plugin | `db/schema/index.ts` (a duplicated name is TS2308) |
| `worker-exports.ts` | one `export *` per plugin | `src/worker.ts`, the only place Cloudflare resolves a `class_name` from |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS` / `cliPlugins` | `cli.ts` |

- **The two `export *` barrels carry an empty marker** (`export {}`) — never delete it: with no
  plugin line the file becomes a SCRIPT and its importer fails TS2306.
- **Two names per barrel, not style**: the `as const` TUPLE in a type position (`SERVER_PLUGINS`),
  the widened list in a loop (`serverPlugins`) — an EMPTY tuple indexes to `never`.
- `ServerPlugin<S>` / `UiPlugin<S>` are generic over the plugin's `SharedPlugin`: `jobHandlers`,
  `agents`, `prompts`, `agentForms` must cover exactly the keys it declared. Only the merge is cast.

## Boundaries — what a plugin imports, and what it may never do

- **Exactly four published entries** — `src/plugins/<id>/index.ts`, `<id>/ui/index.ts`,
  `packages/shared/src/plugins/<id>/index.ts`, `apps/cli/src/plugins/<id>/index.ts`. **No deep
  import across a plugin boundary**, in either direction, except the six barrel lines.
- **A plugin imports the host only from a DECLARED entry, and receives everything else as injected
  context.** Server: `@/plugins/api` — `const ctx: RequestCtx = requestCtx(c)` in a route, `jobCtx`
  / `cronCtx` / `toolCtx` / `workflowCtx` / `publicCtx` / `emailCtx` elsewhere, `HookCtx` /
  `SeedCtx` in hooks, `DetachedCtx` for a callback that outlives the handler. Two things cannot be
  injected and are entries instead: `@/db/schema/kit` for a table file (imported by RELATIVE path —
  drizzle-kit bundles it and resolves no tsconfig alias) and the split UI kit.
  `@testkit/{integration,unit}` is for its tests; `@/host/<id>/…` (its OWN id) for the host files it
  seeded. `tests/helpers/plugins.ts` enforces it. **Annotate
  the context explicitly**: `ctx.notFound()` narrows (`never`) only on an explicitly typed target,
  so `const ctx = requestCtx(c)` leaves the row possibly undefined.
- **Module-evaluation order is the one trap the type system cannot see.** `queues/jobs.ts`,
  `agents/registry.ts`, `prompts.ts`, `scheduled.ts`, `api-prefixes.ts` and `access.ts` read the
  barrels at MODULE SCOPE; a plugin module reading one of their values at its own module scope
  closes a cycle and one side holds `undefined` — a crash at import. Avoid it with **`import type`**
  for anything only a type (`AgentToolContext`, `Tool`) and by **naming the file directly** rather
  than a barrel that re-exports the plugin (`db/schema/feature-flags`, not `db/schema`).
- **Its shared module imports no composer at runtime** (the five above): two zod modules in a cycle
  crash at module evaluation. Whole-declaration `import type` is fine; `import { type X } from` is
  not (`tests/config/shared-imports.test.ts`). Host side, for the same reason: **a registry a plugin
  composes into is a FUNCTION, not a const** (`visibilityResources()`); a VALUE a plugin needs moves
  to a leaf (`services/access-sql.ts`).
- **A plugin declares `relations()` for its OWN tables only** — a second `relations()` on a core
  table silently strips `with:` from that table's queries app-wide (`schema.ts` header).
- **It ships no migration** — the HOST generates it. Its `migrations/` holds plain-SQL DATA
  fragments (backfills), never DDL — a foreign snapshot makes the next `db:generate` drop app
  tables.
- **It edits no toml, no `package.json` and never `src/worker.ts`.** Bindings, crons, `[vars]` and
  dependencies are declared in `plugin.json`; `pnpm provision cloudflare <env>` writes BOTH tomls
  (`.claude/rules/cloudflare.md`). A line it needs in any other core file (`vite.config.ts`'s dev
  proxy or an alias) is a declared `coreEdits` entry — anchored on text, applied by `plugin add`,
  reverted by `remove` — never a hand edit. A DO / Workflow class is re-exported (nothing else) from
  `src/plugins/<id>/worker-exports.ts` and named in `workerExports`.
- **It never renames anything across releases** — expand/contract only; drizzle-kit's rename prompt
  has no non-interactive answer, so a rename stops an unattended install dead.
- **It composes, never redefines** — core tables, auth, tenancy, cross-cutting middleware are CORE
  changes. A tenant credential goes through `sealSecret` / `openSecret`, never its own crypto.
- **Compatibility is OBSERVED, not versioned**: a top-level `minKit` floor (bare `X.Y.Z`) and
  `uses` (written by `pnpm plugin export`, **never by hand**), checked as `uses \ ledger`.
- **Changed a member of a declared entry** (`plugins/api/**`, `@/plugins/types`, `@/db/schema/kit`,
  shared/CLI plugin APIs, `@testkit/*`)? Run `node scripts/plugin-api-doc.mjs`, commit its output.

## Namespacing

The id is `^[a-z][a-z0-9-]*$`, never contains `rocketflare` (the rename rewrites it), never a barrel
filename or `api` (the host's dir), and everything carries it. Tables are prefixed with the id's
first hyphen-separated segment (`example-feature` → `example_*`; longer is fine — the CHECK is that
no two installed plugins declare one table name); job types `<id>.verb`; CASL subjects;
prompt/agent/feature keys; query-key roots `<id>:…`; `/api/<id>`; public routes `/api/hooks/<id>`;
the CLI command `<id>`; skills `<id>` / `<id>-<what>`; AG-UI CUSTOM events `<id>.` — **never
`kit.`**, the core namespace.

## Server slots (`ServerPlugin`)

- **Its routes are kit routes in every respect** — `createRouter()`, `validate()` with a contract
  from its own shared entry, `ctx.guard` with its own subject, typed errors, a tenant predicate on
  every query. Only REGISTRATION differs: `mounts` (`['/api/<id>', router, middleware?]`), spread
  LAST.
- **A feature flag gates the MOUNT, not each route** — `requireFeature('<id>')` as the third element
  (404 `feature_disabled`); never `access Feature:<id>` (global admins' `manage all` passes it).
- **A prefix outside `/api`** goes in `apiPrefixes` (else the SPA catch-all answers `index.html`)
  and needs `[assets] run_worker_first` in BOTH tomls (provision writes it) and a Vite dev-proxy
  line (a `coreEdits` entry after `'/ws': proxyTo(`).
- **Unauthenticated routes live under `/api/hooks/<id>` and nowhere else** (`publicMounts`; no
  session, no gate). The handler (`const ctx: PublicCtx = publicCtx(c)`, no tenant) PROVES the
  caller — `verifyState` over a token it minted with `signState`, a stored per-subscription secret,
  the provider's signature; every failure the same 401 — then uses only the tenant that proof
  carried, re-checks its flag with `ctx.features(tenantId)` (no `requireFeature` without auth) and
  answers by `ctx.enqueue`. A callback completing a flow an admin started re-checks them with
  `memberCan(ctx, { tenantId, userId }, action, subject)` — membership, role, block and tenant
  status as of now — right after `verifyState`, because a signed state outlives a demotion. Rate-limit / body-cap overrides: `/rf-plugin` reference.
- **`publicSites` answers whole hosts** for anonymous readers: its router takes everything on a
  host from `hosts(config)`, so the app's `/api/*` and `/auth/*` do not exist there. Return `null`
  from `hosts` on bad config (dormant, plain 503). `cache.generation` and `csp` run on cache hits,
  so neither touches Postgres. Find the owner with `resolveOwnerTenant(db, config, slug)`, and branch
  on `TENANCY_MODE` only there and in the config parser. Declare the hosts var in the manifest
  (`"publicSites": { "hostsVar": "SITES_HOSTS" }`). Site scripts and styles load from
  `/site-assets/` only: the admin bundle in `/assets/` is outside the public CSP.
  `docs/CONCEPTS.md` §16 has the rules.
  One page that embeds something adds its own sources with `PUBLIC_SITE_PAGE_CSP_HEADER` (JSON,
  `PublicSiteCsp`); the middleware applies it on hits and misses and strips it.
- **`appOwned` manifest paths are the developer's**: `plugin upgrade` leaves them alone, and
  `plugin remove` needs `--force-app-owned` to delete files changed or added there.
- **It signs people in through `identityFor(c, '<id>').signIn(...)` and provisions through
  `provisionFor(ctx, '<id>')`, never by writing a session** — no `user_sessions` row, cookie,
  `admitUser` or `tenant_users` write of its own. Both trust the caller about the tenant — prove it
  first. `linkByEmail: true` ONLY for a domain the connection proved it owns, or one tenant's IdP
  can sign in as anyone; without it the seam refuses to claim or CREATE any address no link
  covers (`account_exists`), and a `BOOTSTRAP_ADMIN_EMAILS` address is refused always. A
  suspended tenant answers 403 `tenant_suspended` from every tenant-taking method. `loginMethods` `startPath` must be under `/api/hooks/<id>/`. Semantics
  (leaver vs block, `single` mode, error codes): `rf-plugin/reference.md` § Identity and SSO.
- **`ssoPolicy`** answers `{ required: true, methodId }` only for a domain your connection proved; a
  throw fails CLOSED. A plugin with several tenants' connections sets `connectionId` on the answer
  and passes the same id to `signIn`, or another tenant's connection satisfies the claim. Host side: **every sign-in path asks the policy before it admits** — a new
  path that skips it is a hole in every customer's SSO requirement. Never import `routes/auth/sso`
  statically from `plugins/api/**` (it reads the barrel; use `await import`). Worked examples:
  `example-feature/api/sso.ts`, `sso-policy.ts`.
- **`emailHandlers` claim a recipient LOCAL PART** (`receipts` takes `receipts+tag@…`, `*` is the
  catch-all; two plugins on one part fail `plugins.test.ts`). The host rejects unclaimed mail and
  turns a throw into a sender retry, never a bounce; the handler (`emailCtx`, no tenant — an
  address is not an organisation) parses MIME, checks the sender, resolves the tenant, stores and
  enqueues. Routing the address to the Worker is a per-zone Cloudflare step, in no toml.
- **`ctx.startAgentRun`** (`JobCtx`, `CronCtx`, `EmailCtx`, `PublicCtx`) starts a run from the
  background through the route's own gates; each refusal throws. **A job always passes an
  `idempotencyKey` naming the work** (`receipt:<documentId>`, never the message id). Never insert
  into `agent_runs` or call `AGENT_RUN_WORKFLOW`.
- **A streamed answer is `return streamChat(c, { promptKey, feature, message, tools, … })`**
  (`@/plugins/api`), never a hand-built stream: `promptKey` is one of YOUR `prompts` (its owner is
  the namespace), `feature` is `<id>` / `<id>:x` / `<id>.x`, `tools` is a BUILDER called inside the
  stream with a `StreamChatToolCtx` (the stream's `db` + `emit`), and every CUSTOM event goes
  through `emit('<id>.x', value)` — another name, or `kit.`, ends the run with `RUN_ERROR`
  `invalid_custom_event`. Validate the body and do anything else that can fail BEFORE calling it.
  Test it with `scriptPlatformChat(env, turns)` from `@testkit/integration`, never a `vi.mock` of
  the resolver.
- **Storage is `ctx.storage()`** (keyed `tenants/<tenantId>/<id>/…`, so `tenant.purge` removes it),
  never `env.FILES` with a hand-built prefix.
- **Knowledge goes through `ingestDocument` / `ingestDocumentFile`**, never a `documents` insert:
  `source: '<id>:<kind>'` + the upstream `externalId` so a re-sync upserts; `deleteIngestedDocument`
  for upstream deletes. Visibility defaults to the whole organisation — one person's data passes the
  owner's `userId` + `visibility: 'groups'` + `groupIds: []`. Declare `requires.surfaces:
  ["feature-knowledge"]`.
- **Platform knowledge** (content about the APP, readable by every tenant): `ingestPlatformDocument`
  / `prunePlatformDocuments` from a `JobCtx` / `CronCtx` only (`kind` brands them; an `EmailCtx`
  is a type error), `source: '<your id>:<kind>'`, embedded synchronously by the platform embedder.
  It throws `PlatformEmbeddingsError` with nothing written when there is none and returns
  `unchanged` for the same text, so a cron can resync everything cheaply. Find it with
  `searchKnowledge(ctx, { platformSources })`, or declare `knowledgeSources(scope)` so the kit's
  `search_knowledge` tool covers it. **Never tenant data**: every organisation reads it.
- **`jobHandlers`** keep the kit's handler contract (own DB client, await everything, throw to
  retry).
- **`agentTools(ctx)`** is bound to the run's `AgentToolContext` (its `AccessScope`: read what the
  REQUESTER may read, never a `tenantId` it chose). A tool that writes is offered on
  `ToolCtx.can('manage', YOUR_SUBJECT)`, never on `scope.bypass`, which is row visibility. Appended after the kit's three knowledge tools;
  `[]` for a tenant without it; a throw is logged and skipped. A test pinning the tool list must be
  a prefix assertion.
- **`grants` are ADDITIVE over its OWN subjects** (declared in `SharedPlugin.subjects`), applied
  after the kit's matrix; never `cannot` — that would change what every role may do.
- **`hooks.onTenantCreated` / `onTenantDeleted` / `seedDemo` are post-commit, idempotent,
  best-effort**, try/caught after the kit's own — nothing a tenant NEEDS may arrive only that way.
  `seedDemo` gets a namespaced `demoId`; fixed ids + `onConflictDoNothing`.
- **`onTenantDeleted` is for state the FK cascade cannot reach** (its tables are already gone): run
  from `tenant.purge` with the tenant id and `env`. **DO state is purgeable only because instance
  names are DERIVED** — declare a FINITE key set derived from the tenant id and loop it
  (`NotificationsHub`'s `idFromName(tenantId)`); one DO per ROW cannot be purged. A purge-intent
  ledger is **deferred until somebody needs it**.
- `visibilityResources` — its predicate is ANDed onto the tenant one and counted in 409
  `group_in_use`. `rlsExcludedTables` / `unscopedAllowlist` — its entries in the two enforcement
  tests, keyed as the kit keys its own (path under `apps/web/` → reason).
- Cross-plugin registries go through `extensions` (`Record<string, readonly unknown[]>`); the owning
  plugin narrows with zod and fails loudly.

## UI (`UiPlugin`, entry `src/plugins/<id>/ui/index.ts`)

- **Nothing in the shell names a plugin** — `App.tsx` (routes and `PluginHeaderSlot`), `SideNav`,
  `SettingsLayout`, `Home.tsx`, `queryKeys` and `agents/forms` (`CORE_AGENT_FORMS` + each plugin's
  `agentForms`) read `uiPlugins`.
- **The UI entry ships in the MAIN bundle**, so it wires and nothing else. `routes` are per tier
  (`shell`, `noTenant`, `public`, and `workspace`: inside `Layout`, tenant and `guard` still
  enforced, icon-rail nav, no padding, the page fills the viewport under the header with `h-full`)
  and every `Component` is `lazy(() => import('./pages/X'))` — every
  dynamic `import()` inside `lazy`. Runtime imports are limited to `react`,
  `@heroicons/react/24/outline`, `@rocketflare/shared/*`, `@/plugins/types`,
  `@/plugins/api/ui-wiring`, `@/ui/components/SideNav`, `@/ui/hooks/useNavGuard`,
  `@/ui/lib/feature-guards` (type-only are free); `tests/config/plugins.test.ts` enforces both.
- **The UI kit is two modules.** `@/plugins/api/ui-wiring` (`NavItem`, `NavGroup`, `NavGuard`,
  `TabConfig`, `QuickLink`, `useNavGuard`, `featureGuard`) is the entry's kit module;
  `@/plugins/api/ui` (`components/shared`, `showToast`, `SideNav` for a REAL-nav test…) is for a
  lazy PAGE.
- **`nav` is a list of GROUPS** spliced by `composeNav(CORE_NAVIGATION, …)`: `before: '<label>'`
  inserts before that core group, no `before` lands above "Organisation", an unknown label appends;
  `filterNavConfig` applies the same guards. `settingsTabs(ctx)` append after the kit's.
- **`header` items** (`{ id, Component: lazy(...), guard?, order?, placement?: 'center' | 'end' }`)
  go in the top bar via `PluginHeaderSlot` — `center` for a search box, `end` (default) before the
  kit's widgets; sorted by `order`, plugin id, item id; each in its own `Suspense` + error
  boundary, so a throw renders nothing. Keep one compact at every width (an icon button below
  `sm`); a palette or drawer it opens is its own lazy chunk. Guard it with the same const as the
  route it serves.
- A route's guard, its nav item's and its `homeLinks` entry's are ONE const declared beside them
  (`EXAMPLE_FEATURE_GUARD`), so no link points at a page its reader cannot open. `homeLinks` go
  AHEAD of the core Home links, un-deduplicated.
- **`queryKeys` roots start with `<id>:`** (checked), and **the root IS the `entity` string of the
  server's `entity.changed` nudge**, declared once (`EXAMPLE_NOTES_ENTITY` in `shared.ts`), so
  `invalidationsFor()` covers it with no socket code. Its own hooks read its `query-keys.ts`, never
  the merged `queryKeys` (it must work installed alone or fifth).
- **Heavy dependencies stay in its lazy chunk** — never reached from the entry, `components/shared`,
  `App.tsx`, `SideNav` or an eager hook. Compare `pnpm web build:ui` output before and after
  touching an import. A registry the browser reads is a separate file from the one composing other
  plugins' contributions (that one reads the server barrel and drags `postgres` into the UI bundle).
- **CSS:** its pages are scanned by `index.css`'s `@source "../plugins/**/ui/**/*.{ts,tsx}"`; a
  library's precompiled CSS needs no scan line and is imported beside the library in its lazy
  component, never added to `index.css`.

## Skills and tests a plugin owns

- **Agent skills live at `skills/<dir>/` in the plugin repo, declared in `"skills"`** — never under
  its own `.claude/`, which is never copied. Anything a person must SET UP or OPERATE deserves one
  (`/rf-plugin` §6; `.claude/skills/example-feature/`).
- **Hooks for the host's coding agent are `"claudeHooks"`** (`{ "Stop": [{ "command", "timeout"? }] }`),
  merged into `.claude/settings.json` by `plugin add`, replaced by `upgrade`, removed exactly by
  `remove`. The command is only `node "$CLAUDE_PROJECT_DIR/.claude/skills/<dir>/<script>.mjs"`
  (plain flags allowed) over a script a declared skill ships — never `pnpm`, `cd`, `&&`.
- **Content the developer owns is `"hostFiles"`** (`[{ "path", "from" }]`): seeded once into
  `docs/<id>/`, `apps/web/public/<id>/` or `apps/web/src/host/<id>/`, never touched by `upgrade`,
  left by `remove`. Plugin code reads the last as `@/host/<id>/…` — its own id only. Never put
  something the plugin must keep in step there: the developer may have edited or deleted it.
- **A tenant-isolation test** under `src/plugins/<id>/tests/api/` for every tenant-scoped table — a
  second organisation that can neither list, read nor delete the first's rows. The host cannot write
  it; `plugin check` only proves it exists. Every tenant table calls `tenantIsolation()`. A plugin
  with its own query surface (the analytics plugin's cubes) owns the test that proves it scopes.
- Analytics plugin conventions (dashboards, cubes, fact tables), once installed:
  `analytics/CLAUDE.md` and the ones beneath it.


## Adding a SLOT (a field on `ServerPlugin` / `UiPlugin` / `SharedPlugin` / `CliPlugin`)

The field in `plugins/types.ts` (or the shared/CLI one), with a doc comment saying what it merges
into and what the host does NOT do; the consumer reads the widened list (a CLOSED set becomes `X =
[...CORE_X, ...plugin X]`); **then, not optional**, a case in `tests/config/plugins.test.ts` (or the
registry's core test) as a pure helper over a FIXTURE — a rule that runs only when a plugin is
installed proves nothing — and `docs/CONCEPTS.md` §16 + the matching `.claude/rules/*.md`, same
commit. Never a slot that lets a plugin revoke a grant (`cannot`), write a migration or edit a toml.
