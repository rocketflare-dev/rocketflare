# Neon serverless as the only database driver (D35)

This is the design for replacing postgres.js and Hyperdrive with the Neon serverless driver. It
would be kit **0.15.0**, a breaking release. The rules that stay true after it ships go in
`docs/CONCEPTS.md` §4 and §10, and they replace D2 ("postgres.js is the only driver").

Status: **proposed, not built.** It was agreed in outline on 2026-09-27 and is to be reviewed
before any work starts. 0.14.0 shipped the non-breaking changes from the same request (OIDC, the
external deployer, dev ports, `bootstrap --db-url`, the `db-roles` Neon fix).

## 1. Decision

Drizzle over the **Neon serverless driver** becomes the kit's one database driver, everywhere:
Worker, queues, cron, workflows, scripts and tests.

- **Queries** go over HTTP (`drizzle-orm/neon-http`), which is one round trip per query.
- **`db.transaction(...)`** goes over a WebSocket `Pool` (`drizzle-orm/neon-serverless`) opened
  lazily for that request and closed with the handle.
- **Locally and in tests**, the same driver points at the compose Postgres through a Neon proxy
  container.
- **postgres.js leaves the runtime, and Hyperdrive leaves the kit.**

Opting in behind a `DATABASE_DRIVER` switch was considered and rejected (§8).

## 2. Why

**Hyperdrive caps a fleet.** An account gets 25 Hyperdrive configs, which is roughly 12 apps with
staging and production. A platform that runs many kit apps can't give each one Hyperdrive.

**Without Hyperdrive, postgres.js is slow.** It falls back to direct TCP from the Worker, measured
at about 800 ms per request. Neon's HTTP path was measured at about 105 ms per query, against
about 95 ms through Hyperdrive.

**Coding sandboxes have no TCP out.** Only HTTPS and WebSocket leave them, so `migrate`, `seed`
and `db-roles` can't reach Postgres there at all with postgres.js.

**Two driver paths would rot.** The gate exercises one driver. An opt-in second driver would be
tested only by a side CI job, and it would still need helpers and a type cast (§8). Keeping one
tested path matters more than keeping Hyperdrive.

## 3. What changes

### 3.1 The client (`apps/web/src/db/client.ts`)
- **`Database`** becomes the Neon HTTP drizzle type, honestly typed. Its `transaction` delegates to
  a `neon-serverless` `Pool` db created on first use, and `close()` ends that pool.
  - Both result types expose `.rows` / `.rowCount`, so there is one result shape.
  - If the transaction types don't unify, `Database` becomes the shared `PgDatabase<…>` base type.
- **One resolver, `openDatabase(env)`,** replaces the eight hand-built ones. Each currently builds
  `{ HYPERDRIVE, PREVIEW_DATABASE_URL, DATABASE_URL }` itself:
  - `middleware/database.ts`
  - `utils/routes/route-helpers.ts` (`streamDatabase`)
  - `queues/jobs.ts`
  - `scheduled.ts`
  - `workflows/agent-run.ts`
  - `plugins/api/workflow.ts`
  - `observability/span-store.ts`
  - `getScriptDatabase`

  The URL is `PREVIEW_DATABASE_URL || DATABASE_URL`.
- **Local routing:** a `NEON_LOCAL_PROXY` var (e.g. `http://localhost:4444`) in `.dev.vars` and
  `.env.test`. When it is set, the client points `neonConfig.fetchEndpoint` and `wsProxy` at it,
  with `useSecureWebSocket = false`. It is unset in deployed environments, so there is no host
  sniffing.

### 3.2 Result shapes
`db.execute()` returns `{ rows, rowCount, … }` instead of a postgres.js `RowList`, which is an
array with `.count`. These core sites move to `.rows` / `.rowCount`:
- `auth/sessions.ts:133,202`: the session resolver, which runs on every request
- `services/traces.ts:134,182`: check that json columns still parse
- `services/agents/runs.ts:724-736`
- `scheduled.ts:78-81`: the delete count

Anything indexing `rows[0]` on a result becomes a type error, which is how we want it to fail.
A cast such as `as unknown as Array<…>` or a `.count` read still compiles and then breaks at
runtime, so a **config test in the gate** fails on those two patterns across `apps/web/src`,
installed plugins included. There is no runtime guard.

### 3.3 Scripts
- `migrate.ts`: the `neon-serverless` migrator over a `Pool`. It keeps `CREATE EXTENSION vector`
  and the `-pooler` → direct-host rewrite.
- `db-roles.ts`: a Pool client with `BEGIN` / `COMMIT` replaces `sql.begin`.
- `seed.ts`, `test-db-connection.ts`, `provision.ts` and the fact-table scripts go through
  `getScriptDatabase` or a Pool.
- `postgres` stays a **devDependency only**, for `drizzle-kit studio` and ad-hoc access to the
  local Postgres. `rules/database.md` bans it (and `pg`) at runtime.

### 3.4 Tomls, secrets, provisioning
- **Tomls:** the `[[hyperdrive]]` blocks leave both files. The parity test drops `HYPERDRIVE` from
  the baseline bindings, and `worker-configuration.d.ts` is regenerated.
- **The Worker's `DATABASE_URL`** becomes a Worker secret holding the **pooled** Neon URI.
  - `pnpm provision secrets <env>` writes it from the credentials `resolveNeon` already fetches.
  - `syncHyperdrivePassword` becomes `syncWorkerDatabaseUrl`, so `--rotate` can't leave the Worker
    with a dead password.
  - The Hyperdrive creation and toml patching in `provision.ts` / `provision/patch-toml.ts` are
    removed.
- **The CI `DATABASE_URL`** (the GitHub Environment secret used by `db:migrate:ci`) keeps its name
  and stays on the **direct** host. It's the same name in a different store, and DEPLOY.md spells
  out which is which.
- **Production Postgres must be Neon.** Hyperdrive was the only way to reach any other Postgres.

### 3.5 RLS enforce mode
`withTenantScope` in enforce mode already runs `db.transaction(tx => set_config('app.tenant_id', …,
true); fn(tx))`. That now runs over the WebSocket Pool, which is exactly its job.

- The app-role connection becomes an **`APP_DATABASE_URL` Worker secret** (pooled host), replacing
  the never-wired `HYPERDRIVE_APP` binding. Nothing in `apps/web/src` reads it today, so no copy
  can be using enforce mode.
- `set_config(…, true)` is transaction-local, so Neon's transaction-mode pooler is fine.
- RLS.md's Hyperdrive cache-leak spike step and the second `--caching-disabled` Hyperdrive config
  both go away.

### 3.6 Local compose and tests
- **The proxy:** `ghcr.io/timowilhelm/local-neon-http-proxy` sits in front of the dev and test
  Postgres. It is a community image that packages Neon's open-source proxy, not an official Neon
  product.
  - It is **pinned by digest**, not tag, in both compose files, with the pin noted in
    `rules/database.md`.
  - If it is abandoned, the fallback is our own image built from Neon's open-source `proxy`.
  - Neon's official "Neon Local" needs a cloud account, which would break zero-credentials local
    development.
- **Ports:** `dev-db.mjs` scans a per-checkout port for the proxy, as it does for Postgres, and
  writes `NEON_LOCAL_PROXY`.
- **Tests:** `tests/mocks/bindings.ts` sets `DATABASE_URL` + `NEON_LOCAL_PROXY` instead of stubbing
  `HYPERDRIVE`. CI's Postgres service gains the proxy.

## 4. Costs and risks

| Risk | Handling |
|---|---|
| Breaking for every copy: tomls, secrets, compose, the `Database` type | `breaking: true` with a step-by-step porting note (§5) and a dry run of it on a scratch copy before tagging |
| Hyperdrive's default 60 s read cache disappears (the kit provisions it without `--caching-disabled`) | Stated in the note. Watch database load after cutover |
| Multi-query request latency over HTTP | No go/no-go gate: this is the only path to the fleet goal. Watch p95 for a day after cutover, and fix forward (first candidate: batch session + membership in one neon-http `batch()`) |
| A WebSocket handshake per transaction, e.g. every chat retrieval (`SET LOCAL` in `retrieval.ts`) | Accepted: it sits inside a multi-second model call. Measure after cutover |
| A community proxy image becomes a hard dependency of dev, CI and every bootstrap | Digest pin, plus the self-built fallback (§3.6) |
| drizzle-cube (analytics) reads results itself from the handle it is given | Must be proven by the spike (§6). If neon-http breaks it, the cube route gets a Pool-backed handle |
| Neon HTTP limits (response size, statement timeouts, no multi-statement) | Covered by the full gate through the proxy. Keep large exports on the Pool |

## 5. Upgrading a copy

Order matters. The plugin compatibility check works by name (`uses \ ledger`), so it can't see
the `Database` type change.

1. **Plugins 3.4.0 first** (`minKit` 0.13.0). Analytics reads `execute()` results in both shapes,
   so it runs on 0.13, 0.14 and 0.15. A copy can take it any time. `defaultPlugins` in
   `.rocketflare.json` still pins analytics at the stale `3.0.0`, and 0.15.0 bumps it.
2. **Upgrade the kit to 0.15.0**, then run `pnpm typecheck && pnpm web test:config` and fix every
   flagged `execute()` site to use `.rows` / `.rowCount`.
3. **Set the Worker secret per environment:** `NEON_API_KEY=… pnpm provision secrets staging`, or
   `wrangler secret put DATABASE_URL` with the pooled URI from the Neon console. The 0.14 Worker
   ignores it, so this can happen before the deploy.
4. **Deploy staging,** check `/api/ready`, and watch p95. Then do production.
5. **Keep the Hyperdrive configs for about a week.** `wrangler rollback` to 0.14 restores that
   version's `HYPERDRIVE` binding and needs the config to still exist. There are no migrations
   (`migrations: []`), so the schema is identical in both directions. Deleting the configs is a
   separate cleanup step, never part of the upgrade.
6. By hand: the compose file and `.dev.vars` (`NEON_LOCAL_PROXY`).

Before tagging, send known copies a heads-up covering what changes, the cutover, the rollback
story and plugins-first, and offer to pair on their production cutover. There is no rc tag: the
tag pattern and deploy pipeline assume plain `X.Y.Z`, and the scratch-copy dry run gives the same
confidence.

## 6. Spike (functional, before building)

The spike proves the proxy and driver can do everything the kit does. It is not a performance
gate. If the community image fails a check, we build our own proxy image; the direction doesn't
change.

- neon-http queries through the proxy
- a `neon-serverless` Pool transaction with `set_config(…, true)` and `SET LOCAL`
- the drizzle `neon-serverless` migrator, including `CREATE EXTENSION vector`
- one proxy serving both the dev and test databases, or one proxy each
- drizzle-cube over a Neon handle: the kit's analytics `cube-isolation` test
- `pnpm test` runtime through the proxy, recorded against today's

## 7. Work breakdown

1. The spike (§6).
2. Plugins 3.4.0: a dual-shape helper in analytics (written in plugins PR #6), and a lockstep
   release with "no change" notes for the other plugins.
3. Kit branch:
   - the client and resolver (§3.1)
   - result shapes and the gate guard (§3.2)
   - scripts (§3.3)
   - tomls, provisioning and secrets (§3.4)
   - RLS (§3.5)
   - compose and test harness (§3.6)
   - `defaultPlugins` → 3.4.0
4. Docs:
   - CONCEPTS §4 and §10 (D2 replaced by D35)
   - CLAUDE.md stack line
   - `rules/database.md`
   - DEPLOY.md (topology, secrets, "the Worker holds `DATABASE_URL`", Neon required)
   - RLS.md, SETUP.md
   - the rf-provision skill and its reference
5. Porting note (§5), then the scratch-copy dry run, then the heads-up, then the 0.15.0 release,
   then the site.

## 8. Considered and rejected

- **Opt-in `DATABASE_DRIVER = postgres | neon`.** It is non-breaking, but it leaves two driver
  paths with only one tested by the gate. It also needs `rowsOf` / `affectedRows` helpers plus a
  type cast that lies under Neon.
- **WebSocket Pool only.** One drizzle flavour and the simplest typing, but every request pays a
  WebSocket handshake to Neon. HTTP for queries plus a Pool for transactions matches what was
  measured.
- **A perf go/no-go gate.** Dropped because there is no alternative path to the fleet goal.
  Latency is watched after cutover and fixed forward instead.
- **Renaming the CI secret** (e.g. `MIGRATION_DATABASE_URL`). It would be churn for existing
  copies. Keeping both named `DATABASE_URL` is documented instead.
- **Neon Local (official).** It proxies to cloud branches only, which breaks offline, zero-credential
  local development.

## 9. Open questions for review

- Does `Database` stay the concrete neon-http type, or become the `PgDatabase<…>` base? This
  decides what `docs/plugin-api.md` shows plugin authors.
- Can the `.count` / cast guard live in `plugin check` too, so it catches a plugin before install
  as well as in the host's gate?
- Should `openDatabase` expose a `pool()` escape hatch for long exports and drizzle-cube, or keep
  the Pool strictly behind `transaction`?
- Is `NEON_LOCAL_PROXY` the right name for a var that also appears in `.env.test` and CI?
