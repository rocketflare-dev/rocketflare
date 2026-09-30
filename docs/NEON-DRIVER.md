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
  them to plugins. The file is the driver SEAM (`apps/web/src/db/CLAUDE.md`): it also parses raw
  arrays under postgres.js with Neon's own parsers (`ARRAY_PARSERS`) and reads a driver error's
  SQLSTATE through the cause chain (`pgErrorCode()`, `isUniqueViolation()`).
- **`loadConfig`** — `DATABASE_DRIVER` (enum, default `postgres`), `NEON_LOCAL_PROXY` (URL);
  `neon` without `DATABASE_URL`/`PREVIEW_DATABASE_URL` is a `ConfigError` at startup.
  `AppBindings = Cloudflare.Env & { HYPERDRIVE?: Hyperdrive }`.
- **The guard** — `tests/config/driver-results.test.ts` (TypeScript AST over `src/`, plugins
  included): no cast, index or `.rows`/`.rowCount`/`.count`/`.length` on an `execute()` result, no
  cast to a `{ count | rowCount | rows }` literal, no driver import outside `db/client.ts`, no
  SQLSTATE read by hand (`err.code === '23505'`, a `case` on a `.code`), and no session state
  outside a transaction — a statement `SET`, `set_config(…, false)`, `pg_advisory_lock`,
  `CREATE TEMP TABLE` are allowed only inside a callback to `.transaction(…)` / `transaction(…)` /
  `withTenantScope(…)`, because neon-http runs every other query on a fresh connection. `LISTEN` /
  `UNLISTEN` are refused everywhere (neon-http has no notifications).
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
- **Tests** — the suite runs `postgres`. The `driver` vitest project (`tests/driver/`) is the
  CONFORMANCE suite for the seam: each test states one equivalence through `openDatabase`, over
  HTTP and inside a transaction, and passes unchanged under both drivers
  (`tests/config/driver-conformance.test.ts` fails a skip or a per-driver expectation). `pnpm test`
  runs it under `postgres` with the suite, then again under `neon` through the proxy — in every
  gate, a copy's CI included; on a remote Neon gate branch the whole suite runs under `neon`
  instead. `kit.yml`'s plugins pass runs the whole suite, default plugins installed, under `neon`
  (`GATE_SUITE_DRIVER=neon`, ~35 s locally).

## 4. The local Neon proxy

`ghcr.io/rocketflare-dev/local-neon-proxy:rf-<n>` — OUR image (`apps/web/docker/Dockerfile.neon-proxy`):
a byte-identical mirror (`:2026-03-27`, same digest) of the community image
`ghcr.io/timowilhelm/local-neon-http-proxy` (Neon's open-source proxy plus Caddy, CC0) with our
start script baked in as the entrypoint. **Pinned by digest** in both compose files (profile `neon`;
the test proxy on :4433). The kit therefore depends on no third party's registry. Neon's official
"Neon Local" proxies to cloud branches, which breaks zero-credential local development.

The script is BAKED, not bind-mounted: a mount only works where the Docker VM can see the checkout
(Colima and remote contexts share `$HOME` at most), and a missing source silently mounts as an
empty directory — measured on Colima with a checkout under `/tmp`.

Out of the box it measured **~70 ms per query** against ~0.3 ms of actual work, and failed under a
parallel suite. The proxy's `postgres` auth backend (a mock control plane) caches no role secret,
so every HTTP query paid a 4096-round SCRAM exchange plus two fresh backend logins; its endpoint
rate limiter (500/s) then rejected the suite with "Too many connections to this endpoint";
and HTTP connection pooling is opt-in, which only `-pooler` hosts trigger. Logging was not a
factor. `apps/web/docker/neon-proxy-start.sh` replaces the image's start script: it re-hashes the
throwaway local role's unchanged password with ONE SCRAM round, raises the rate limit, and pools
HTTP always — **~8 ms per query**. Real Neon caches secrets, so none of this applies deployed. The
proxy creates a `neon_control_plane` schema, which nothing reads.

Changing the script means rebuilding: the command is in the Dockerfile's header (COPY-only, so
both platforms build without emulation), then pin the new index digest in both compose files.

## 5. Measured traps

- **Raw arrays** — postgres.js with `fetch_types: false` skips its array-type lookup and returned
  a `text[]` from raw SQL as the literal `"{x,y}"`, where Neon parses it. **Normalised**:
  `client.ts` installs Neon's own parsers for the array OIDs on the postgres.js client
  (`ARRAY_PARSERS`), so both return `['x','y']` (and `int[]` → numbers, `bigint[]` → strings,
  `jsonb[]` → objects) and the two cannot drift. The date and interval arrays and `numeric[]` stay
  text under both: drizzle keeps them unparsed for its column mappers.
- **Raw timestamps** — Postgres's text (`'2026-01-02 03:04:05.678+00'`) under BOTH drivers:
  drizzle installs transparent parsers for the date types on each. (This section used to say "a
  `Date` under postgres.js"; measured, it is not.) Code reading a raw timestamp parses it; the
  query builder returns `Date`s under both.
- **Raw bigint and numeric** — strings under both.
- **Error codes** — each driver hangs `code` on its own error and drizzle wraps it, so a SQLSTATE
  is read with `pgErrorCode()` / `isUniqueViolation()`, never by hand (the guard).

`tests/driver/driver.test.ts` pins every one with a single expectation for both drivers, read over
HTTP and inside a transaction.

## 6. Costs and risks (as shipped)

| Risk | Handling |
|---|---|
| A fresh copy develops on `postgres` and deploys on `neon` | the seam: `client.ts` normalises, the guard bans what cannot be normalised, and the `driver` conformance pass runs under `neon` in every `pnpm test` (and so every gate and PR); `GATE_SUITE_DRIVER=neon pnpm gate test` / `dev:db:up --neon` run the rest under `neon` by hand |
| An upgrading copy picks up the kit's `DATABASE_DRIVER = "neon"` | tomls are never patched as text by `/rf-upgrade`; its porting rules say not to carry the value; if one did, `loadConfig` fails at startup on the missing secret |
| `neon` has no read cache and a round trip per query | measured per app when it switches (staging p95 against the Hyperdrive baseline); first fix: batch session + membership in one neon-http `batch()` |
| A WebSocket handshake per transaction under `neon` (every chat retrieval's `SET LOCAL`) | accepted — it sits inside a multi-second model call |
| A community image in every local `pnpm test` and `dev:db:up --neon` | digest pin, our own start script, the mirror/build fallback (§4); `pnpm dev` and the narrow test scripts never pull it |
| drizzle-cube (analytics) reads results from the handle it is given | drizzle-cube normalises both shapes itself; analytics 3.4.1 passes the handle as drizzle-cube's type. Checked once before release: all four plugins' 241 tests, `cube-isolation` included, pass under both drivers. In CI `kit.yml`'s plugins pass runs the whole suite with the default plugins installed under `neon`, and a copy's gate runs the conformance pass under both |

## 7. Considered and rejected

- **Neon as the only driver** (the first draft). One tested path, no Hyperdrive — but production
  would have to be Neon, and every copy would take a breaking cutover to fix a fleet problem it may
  not have. The draft's objections to two drivers did not survive the code: two driver-specific
  reads in core, helpers needed anyway (plugins 3.4.0 already wrote one), and the `PgDatabase` base
  removed casts rather than adding one.
- **The whole suite under `neon` in every gate** (the second draft, and again in #49). Local and
  CI would match a fresh copy's deployments, but only for code a test happens to exercise, at the
  cost of the proxy's latency on every query of every run. The seam covers the difference instead,
  including code no test reaches: normalise in `client.ts`, ban in the guard, prove with the
  `driver` conformance project under both drivers in every `pnpm test`. The proxy image IS now in
  every local `pnpm test`, for that one project. The whole suite runs under `neon` only in
  `kit.yml`'s plugins pass — the backstop for a kind of divergence the guard does not know yet —
  and on demand (`GATE_SUITE_DRIVER=neon`).
- **Per-test time budgets for the slow-link cases.** Two tests carried `30_000` and still timed out
  on a real Neon branch (whose default was 60 s — the budget SHRANK it). Time limits now scale with
  the target by one latency factor in `vitest.config.ts` (1 local `postgres`, 4 through the proxy,
  12 on a real Neon branch) for test, hook and teardown alike, and a test that is slow only on a
  slow link lowers the limit it walks to (`runStreamBody`'s `maxMs`,
  `AgentRunWorkflow.maxInterruptRounds`) rather than raising its own timeout.
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
