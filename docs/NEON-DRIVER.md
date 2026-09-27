# Two database drivers: Neon serverless or postgres.js (D35)

Status: **built in kit 0.15.0** (non-breaking). The rules that stay true live in
`docs/CONCEPTS.md` §4 and §10 (D35 replaces D2, "postgres.js is the only driver"), the operator's
view in `docs/DEPLOY.md` § Database driver, and the conventions in `.claude/rules/database.md`.
This file keeps the design record: what was decided, why, what was measured, and what was
rejected.

History: the first draft (2026-09-27) made Neon the ONLY driver, a breaking release that removed
Hyperdrive. On review the same day it became two drivers, so production can run on any Postgres;
then Neon became the deployed default for fresh copies while local development and the gate stay
on postgres.js (§7).

## 1. Decision

`DATABASE_DRIVER` picks one of two Drizzle drivers for the Worker, queues, cron, workflows and
scripts:

| | `neon` | `postgres` |
|---|---|---|
| Driver | Neon serverless: neon-http per query, a WebSocket `Pool` per `db.transaction` | postgres.js |
| Deployed path | HTTPS / WebSocket → Neon only | Hyperdrive → any Postgres |
| Worker holds | `DATABASE_URL` secret (pooled Neon URI) | `[[hyperdrive]] HYPERDRIVE` |
| Read cache | none | Hyperdrive's (60 s default) |
| Hyperdrive configs (25 per account) | none | one per environment |
| Default for | a fresh copy's deployments; `bootstrap --db-url` on a Neon branch | local dev, the gate, every pre-0.15 copy |

It is set in two layers:

- **Deployed — the tomls' `[vars]`.** The kit's say `"neon"` and carry no `[[hyperdrive]]` block
  (wrangler refuses a deploy naming an id that does not exist). **Missing means `postgres`**, so
  copies from before 0.15.0 are unchanged.
- **Local — `.dev.vars` / `.env.test`.** `postgres`: postgres.js over TCP to the compose database.
  This overrides the toml for `wrangler dev`, the scripts and the tests.

## 2. Why

- **Hyperdrive caps a fleet.** 25 configs per account is ~12 apps with staging and production.
- **Without Hyperdrive, postgres.js is slow**: direct TCP from the Worker measured ~800 ms per
  request. Neon HTTP measured ~105 ms per query against ~95 ms through Hyperdrive.
- **Coding sandboxes have no TCP out**, so `migrate`, `seed` and `db-roles` could not reach
  Postgres there with postgres.js.
- **But Neon cannot be the only way in.** Hyperdrive is how a copy reaches a non-Neon Postgres, and
  a single app with one Hyperdrive config has none of the problems above.
- **Two drivers are cheap here.** Almost all data access is Drizzle's query builder, which maps
  both the same. Core had exactly two driver-specific result reads (`auth/sessions.ts`,
  `scheduled.ts`) plus two uses of `db.execute<T>()` in `services/traces.ts` and
  `services/agents/runs.ts`, all found by the type change in §3.

## 3. What was built

- **`apps/web/src/db/client.ts`** — `openDatabase(env)` replaces eight hand-built resolvers
  (middleware, `streamDatabase`, the jobs consumer, `scheduled`, both workflow step helpers, the
  span store; scripts via `getScriptDatabase`). `Database` is `PgDatabase<PgQueryResultHKT, typeof
  schema>`, so a raw `execute()` is `unknown` and the old `tx as unknown as Database` casts are gone.
  The neon handle is neon-http with its `transaction` delegated to a lazily created `Pool` (max 1)
  that `close()` ends. `rows()` / `affected()` read either result shape; `@/plugins/api` exports
  them to plugins.
- **`loadConfig`** — `DATABASE_DRIVER` (enum, default `postgres`), `NEON_LOCAL_PROXY` (URL);
  `neon` without `DATABASE_URL`/`PREVIEW_DATABASE_URL` is a `ConfigError` at startup.
  `AppBindings = Cloudflare.Env & { HYPERDRIVE?: Hyperdrive }`.
- **The guard** — `tests/config/driver-results.test.ts` (TypeScript AST over `src/`, plugins
  included): no cast, index or `.rows`/`.rowCount`/`.count`/`.length` on an `execute()` result, no
  cast to a `{ count | rowCount | rows }` literal, no driver import outside `db/client.ts`.
- **Scripts** — `apps/web/scripts/lib/sql.ts` (`openScriptSql`: text + `$n` params, `transaction`,
  over postgres.js or a Neon `Pool`) under `migrate.ts` (the `neon-serverless` migrator under
  `neon`), `db-roles.ts`, `test-db-connection.ts` and `provision.ts`. Scripts read the driver from
  the **environment only** (the `db:*` scripts load `.dev.vars`); there is no fallback to the
  toml, so `db:migrate:ci` is postgres.js unless CI sets the var. Script and fixture handles
  (`getScriptDatabase`) use the Pool for everything under `neon` (`poolOnly`).
- **Tomls and provisioning** — `DATABASE_DRIVER = "neon"`, no `[[hyperdrive]]` block. The parity
  test wants the block in both files or neither, and none in a `neon` file. `pnpm provision
  cloudflare <env> --driver neon|postgres` rewrites both tomls; `secrets`/`deploy` put the pooled
  URI under `neon`; `--rotate` re-puts it (`syncWorkerDatabaseUrl`) where `postgres` updates
  Hyperdrive.
- **Local** — `pnpm dev:db:up --neon|--postgres` (per-checkout proxy port from :4444, writes
  `DATABASE_DRIVER` + `NEON_LOCAL_PROXY`); the bootstrap writes `DATABASE_DRIVER=postgres` when
  absent, `neon` for a `*.neon.tech` `--db-url`, and takes `--driver`.
- **Tests** — the gate runs `postgres`. A `driver` vitest project (`tests/driver/`) runs the code
  that differs through `openDatabase`: in the gate under `postgres`, under `neon` in
  `pnpm test:neon` and CI's required `test-neon` job, which also run the whole api suite. Under
  `neon` that suite takes ~30 s.

## 4. The local Neon proxy

`ghcr.io/rocketflare-dev/local-neon-proxy` — our byte-identical mirror (same digest) of the
community image `ghcr.io/timowilhelm/local-neon-http-proxy`, Neon's open-source proxy plus Caddy,
so the kit does not hang on a third party's registry — **pinned by digest** in both compose files (profile `neon`; the test proxy on :4433). Neon's
official "Neon Local" proxies to cloud branches, which breaks zero-credential local development.

Out of the box it measured **~70 ms per query** against ~0.3 ms of actual work, and failed under a
parallel suite. The proxy's `postgres` auth backend (a mock control plane) caches no role secret,
so every HTTP query paid a 4096-round SCRAM exchange plus two fresh backend logins; its endpoint
rate limiter (500/s) then rejected the suite with "Too many connections to this endpoint";
and HTTP connection pooling is opt-in, which only `-pooler` hosts trigger. Logging was not a
factor. `apps/web/docker/neon-proxy-start.sh` replaces the image's start script: it re-hashes the
throwaway local role's unchanged password with ONE SCRAM round, raises the rate limit, and pools
HTTP always — **~8 ms per query**. Real Neon caches secrets, so none of this applies deployed. The
proxy creates a `neon_control_plane` schema, which nothing reads.

If the image disappears: mirror the pinned digest, or build one from Neon's `proxy` crate.

## 5. Measured traps

- **Raw arrays** — postgres.js with `fetch_types: false` returns a `text[]` from raw SQL as the
  literal `"{x,y}"`; Neon parses it. Raw SQL returning a list uses `json_agg` / `to_jsonb`.
- **Raw timestamps** — a `Date` under postgres.js, a string under neon-http; code reading one wraps
  it (`asDate`). The query builder maps both.
- **Raw bigint** — a string under both.

`tests/driver/driver.test.ts` pins all three, per driver.

## 6. Costs and risks (as shipped)

| Risk | Handling |
|---|---|
| A fresh copy develops on `postgres` and deploys on `neon` | `test-neon` on every PR; the guard catches driver-specific reads before either; `pnpm test:neon` / `dev:db:up --neon` reproduce locally |
| An upgrading copy picks up the kit's `DATABASE_DRIVER = "neon"` | tomls are never patched as text by `/rf-upgrade`; its porting rules say not to carry the value; if one did, `loadConfig` fails at startup on the missing secret |
| `neon` has no read cache and a round trip per query | measured per app when it switches (staging p95 against the Hyperdrive baseline); first fix: batch session + membership in one neon-http `batch()` |
| A WebSocket handshake per transaction under `neon` (every chat retrieval's `SET LOCAL`) | accepted — it sits inside a multi-second model call |
| A community image in `test-neon` and `dev:db:up --neon` | digest pin, our own start script, the mirror/build fallback (§4); the default dev loop never pulls it |
| drizzle-cube (analytics) reads results from the handle it is given | analytics 3.4.0 reads both shapes. Its `cube-isolation` test runs in CI's plugins pass, which is `postgres` — `test-neon` installs no plugins, so a plugin under `neon` is exercised only by `pnpm test:neon` locally (known gap) |

## 7. Considered and rejected

- **Neon as the only driver** (the first draft). One tested path, no Hyperdrive — but production
  would have to be Neon, and every copy would take a breaking cutover to fix a fleet problem it may
  not have. The draft's objections to two drivers did not survive the code: two driver-specific
  reads in core, helpers needed anyway (plugins 3.4.0 already wrote one), and the `PgDatabase` base
  removed casts rather than adding one.
- **`neon` through the proxy locally and in the gate** (the second draft). Local would match a
  fresh copy's deployments, but it puts a community image in every bootstrap and test run for a
  difference the guard, the `driver` project and `test-neon` already cover.
- **`postgres` as the deployed default for fresh copies.** A fresh copy would need Hyperdrive
  before its first deploy and could not deploy from a sandbox.
- **A missing `DATABASE_DRIVER` meaning `neon`** — upgrading would silently switch every existing
  copy's driver.
- **Inferring the driver** from a missing binding or a `*.neon.tech` host. A missing binding would
  silently change drivers, and Neon behind Hyperdrive is a valid `postgres` setup. Only the
  bootstrap looks at the host, to pick a `.dev.vars` default.
- **A WebSocket `Pool` for every query on the Worker** — a handshake per request. HTTP for
  queries plus a pool for transactions matched the measurements. (Node-side handles do use the
  pool for everything — they hold one connection for thousands of queries.)
- **Scaling test timeouts under `neon`** — the slowness was the proxy (§4), not the tests.
- **Renaming the CI secret** (`MIGRATION_DATABASE_URL`) — churn for existing copies; DEPLOY.md
  names the three `DATABASE_URL`s instead.

## 8. Open questions

- Should the raw-result guard also run in `pnpm plugin check`, catching a plugin before install
  rather than in the host's gate?
- Should `openDatabase` expose a `pool()` escape hatch under `neon` for long exports?
- Should the proxy image be mirrored into the kit's own registry now, rather than on need?
