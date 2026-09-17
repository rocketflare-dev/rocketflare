---
version: 0.6.0
previous: 0.5.0
date: 2026-09-17
breaking: true
migrations:
  - "analytics tables leave the kit: an app that kept analytics must install the plugin BEFORE `db:generate`, or `db:generate` drops analytics_pages, analytics_page_groups and the fact table"
  - "the fact table is renamed under the `<id>_*` rule, so even with the plugin installed `db:generate` emits a DROP and a CREATE for it (drizzle-kit asks whether it is a rename — answer `create table`); it is derived data the cron rebuilds"
areas: [shared, db, api, ui, cli, config, docs, scripts]
touches_surfaces: [feature-analytics, example-cube-activity-events, example-cube-tenant-activity-daily, example-dashboard-tenant-overview, example-feature]
requires_surfaces: []
manual: true
---

## What changed

**Analytics left the kit.** It is `rocketflare-plugin-analytics` 1.0.0 now — a separate repository,
installed by `pnpm plugin add`, and listed in `.rocketflare.json` `defaultPlugins` so
`bash scripts/bootstrap.sh` still gives a fresh clone dashboards without anybody doing anything
(D31 decisions 2, 6 and 7; `docs/CONCEPTS.md` §8 is now a pointer, §16 is the decision record).

**The kit is bare.** That was the point of the whole plugin programme: chat, agents and knowledge
are still core, but the first real subsystem is out, and what came out took `drizzle-cube`,
`recharts`, `d3`, `react-grid-layout` and `react-is` with it. A kit with `--no-plugins` has no
`/analytics`, no `/cubejs-api`, no `/mcp`, no `15 * * * *` cron and no chart library in either
bundle.

What moved, in one list: `routes/{cube-api,analytics-pages}.ts` · `api/cubes/**` · `src/dashboards/**`
· `services/{dashboard-templates,fact-tables/**}` · `db/schema/{analytics-pages,analytics-page-groups,facts/*}`
· `packages/shared/src/analytics.ts` · `ui/{pages,components}/analytics`, the three analytics hooks
and the nav item · the `refreshFactTables` cron task · the `onTenantCreated` dashboards hook · the
`Dashboard` and `Analytics` subjects and their grants · the dashboards visibility resource · the
demo seed's analytics block · and every test that covered them.

**`pnpm web db:refresh-facts` and `db:check-facts` are gone.** They were `apps/web/scripts/*.ts`,
which is not a directory a plugin may own — a plugin has to stay reversible by deleting its own
trees. They are `rocketflare analytics refresh-facts` and `rocketflare analytics check-facts`: one
organisation rather than every tenant, over a route rather than a bare `DATABASE_URL`, and the
refresh ENQUEUES (`analytics.refresh-facts`) because a route never runs long work. `check-facts`
keeps the old exit-1-when-stale contract, so a pipeline health check is a one-word change.

### Core changes you get whether or not you use analytics

- **`UiPlugin.homeLinks`** — a new slot. A plugin may add a Home quick link beside the kit's, with
  the same guard object its route uses. Analytics needed it (it had one); `Home.tsx` composes
  `[...plugins, ...CORE_QUICK_LINKS]`.
- **`ServerPlugin.hooks.onTenantCreated` gains a fourth argument, `features`.** A hook that CREATES
  rows is the sharpest feature door there is and it has no nav entry to hide behind; the analytics
  plugin's dashboard templates are the worked example. **A plugin implementing this hook must widen
  its signature** (an extra parameter is safe to ignore, so this is source-compatible).
- **`api/services/access-sql.ts` is a new LEAF** holding `AccessScope` and `sharedWithMyGroups`,
  re-exported from `services/access.ts` so no existing importer moves. A plugin's visibility
  resource imports the leaf, because `access.ts` reads the plugin barrel.
- **`VISIBILITY_RESOURCES` became `visibilityResources()`**, a memoised function, for the same
  reason. If you named the const, rename the call.
- **The barrel writer learned Biome's line width.** Two plugins in one `as const` tuple stopped
  fitting on 100 columns, and `removeBarrelLine` is documented as the exact inverse of
  `addBarrelLine` — a one-line writer against a wrapped file reported a diff that was not there.
- **`pnpm plugin check` no longer holds a plugin AUTHORED IN THE KIT to its `requires.kit` range**
  (sidecar-recorded, `isKit`). Its floor is always one release ahead of `package.json` until
  `kit:release` runs, which is the authoring loop working rather than a fault. In an app, a
  `--local` plugin is still checked.
- **A plugin's surface always includes `docs/plugins/<id>/**`**, declared or not. `plugin add`
  copies the plugin's release notes there, so a surface that did not name them left the host with
  files no surface classifies (`kit-manifest.test.ts` reports them) and a `remove` that left them
  behind. Found the first time a plugin shipped notes.
- **A plugin repository may carry `scripts/`** — `classifyPluginFile` now treats it as `repo-only`
  beside `.github/` and `package.json`. There is no `pnpm plugin:release`, so an author copies the
  kit's `release.mjs` and the libs it imports into their repo; without this the first real plugin
  was refused at install for carrying exactly the files the kit told it to carry.
- The `feature-analytics` surface and the three analytics example surfaces are gone from
  `.rocketflare.json`; `upgrade-notes.test.ts` gained a `RETIRED_SURFACE_IDS` list so the released
  0.2.0 and 0.3.0 notes, which name them, are not rewritten.

## How to apply

**If you want to keep analytics, install the plugin FIRST — before `pnpm db:generate`.** This is
the whole of the migration risk in this release.

```bash
pnpm kit:upgrade --to 0.6.0            # read the plan
pnpm kit:upgrade --to 0.6.0 --apply

# BEFORE db:generate, if you use analytics:
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugin-analytics.git@1.0.0          # the plan
pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugin-analytics.git@1.0.0 --apply

pnpm db:generate --name plugin-analytics-1.0.0   # read the SQL — see below for what to expect
pnpm db:migrate
```

**What `db:generate` emits, and what your rows do — verified against the real SQL:**

| You | `analytics_pages` | `analytics_page_groups` | the fact table |
|---|---|---|---|
| installed the plugin first | untouched, no DDL at all — **the rows survive** | untouched — **the rows survive** | `DROP TABLE tenant_activity_daily_facts` + `CREATE TABLE analytics_tenant_activity_daily_facts`; drizzle-kit asks whether it is a rename — **answer `create table`** |
| did not | `DROP TABLE` | `DROP TABLE` | `DROP TABLE` |

The fact table is derived data: the `:15` cron refills it within the hour, or `rocketflare
analytics refresh-facts` does it now. **The kit's own journal carries a `0013_kit-analytics-removed`
migration** dropping all three with `IF EXISTS` — that is the BARE kit's history, and it never runs
in your tree, because `kit:upgrade` does not copy a kit migration (§13) and you generate your own.

Then the four things a plugin may not do for you. `pnpm plugin add` prints them as numbered steps:

1. **Both wrangler tomls**: `[triggers].crons` gains `"15 * * * *"`; `[assets].run_worker_first`
   gains `"/cubejs-api"`, `"/cubejs-api/*"`, `"/mcp"`, `"/mcp/*"`. The parity test reads
   `API_PREFIXES`, so a forgotten entry fails your gate rather than silently serving the app shell
   to an `<object>` embed. `pnpm provision cloudflare <env>` writes them from the installed surface.
2. **`apps/web/vite.config.ts`**: `'/cubejs-api': proxyTo()` and `'/mcp': proxyTo()` in the dev
   proxy; `'@nivo/heatmap'` aliased to `./src/plugins/analytics/ui/lib/nivo-heatmap.tsx`;
   `'recharts'` added to `resolve.dedupe`.
3. **Dependencies** — declared in the plugin manifest and installed by `plugin add`.
4. **If you removed analytics instead**: `pnpm --dir apps/web remove d3 drizzle-cube
   react-grid-layout react-is recharts`, and take the cron, the two prefixes and the Vite lines
   back OUT of those same files.

Replace any use of `pnpm web db:refresh-facts` / `db:check-facts` in your scripts and pipelines
with the CLI commands. If you implement `ServerPlugin.hooks.onTenantCreated` in a plugin of your
own, widen its signature to take `features` (or keep three parameters and ignore the fourth).

## Conflicts to expect

**Many, and most of them are files that MOVED.** `kit:upgrade` translates a kit diff into your
names; a file the kit deleted and a plugin re-added at a different path is two operations it cannot
pair up. Expect rejects around `apps/web/src/api/cubes/**`, `apps/web/src/dashboards/**`,
`apps/web/src/api/routes/{cube-api,analytics-pages}.ts`, `apps/web/src/db/schema/analytics-*`,
`apps/web/src/db/schema/facts/**`, `packages/shared/src/analytics.ts` and the analytics UI — and
resolve every one of them by DELETING your copy and letting `plugin add` write the plugin's, which
is the same code translated the same way.

If you had customised any of those files, that customisation is now an edit to the installed
plugin's tree — ordinary source in your repository, which is the point of a plugin being copied in
rather than npm-installed. Note it before you delete.

Genuinely core conflicts to read rather than take: `api/index.ts` (the two analytics mounts leave
the table), `api/scheduled.ts` (`CORE_SCHEDULED_TASKS` loses the `:15` entry), `services/access.ts`
(the leaf extraction + the memoised function), `permissions/abilities.ts` and
`packages/shared/src/permissions.ts` (two subjects leave `CORE_SUBJECTS`), `ui/App.tsx`,
`ui/components/SideNav.tsx`, `ui/pages/Home.tsx`, `ui/lib/query-keys.ts`, `apps/web/scripts/seed.ts`
and `apps/web/src/ui/index.css` (the `--dc-*` block leaves).

## Verify

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green — and with the plugin installed,
  its own tests run in your projects, including the two-tenant `cube-isolation.test.ts`.
- `pnpm plugin check` exits 0 and lists `analytics`.
- `pnpm plugin list` shows it with its repo and pinned version.
- Signed in: **Analytics** in the nav and on Home, the seeded **Organisation Overview** rendering
  with live numbers, and an unauthenticated `curl -i <host>/cubejs-api/v1/meta` answering a JSON 401
  rather than HTML.
- `rocketflare analytics check-facts` reports the fact table `fresh` and exits 0.
- Bundle: `grep -c recharts apps/web/dist/ui/assets/index-*.js` is 0 (with or without the plugin),
  and without it `grep -rl drizzle-cube apps/web/dist` finds nothing at all.
- `REQUIRE_PROVISIONED=1 pnpm web test:config` still passes — that is the check that the cron and
  the two prefixes reached BOTH tomls.
