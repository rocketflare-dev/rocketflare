# Database access

`client.ts` opens a database (`openDatabase(env)`, one client per request), `tenant-scope.ts` wraps
tenant-scoped work (`withTenantScope`, `docs/RLS.md`), `schema/` holds the tables (its own
CLAUDE.md). Rules for queries: `.claude/rules/database.md`.

## The driver seam

The app runs on two drivers (D35, `docs/NEON-DRIVER.md`): `postgres` (postgres.js: local, CI,
Hyperdrive) and `neon` (the Neon serverless driver: HTTP per query, a WebSocket pool per
transaction, the kit's deployed default). **App code is driver-agnostic by construction.**
`client.ts` is the ONLY place the drivers differ. Every divergence is either normalised there or
banned everywhere else, and three things hold it:

- **`client.ts` normalises**: a raw result's shape (`rows()`, `affected()`), a raw array's value
  (`ARRAY_PARSERS`, Neon's own parsers applied to postgres.js), a driver error's SQLSTATE
  (`pgErrorCode()`, `isUniqueViolation()`).
- **`tests/config/driver-results.test.ts` bans** (an AST scan over `src/`, installed plugins
  included):

  | Banned outside `client.ts` | Use instead |
  |---|---|
  | a cast, index or `.rows`/`.rowCount`/`.count`/`.length` on an `execute()` result | `rows(result)`, `affected(result)` |
  | a driver import (`postgres`, `@neondatabase/serverless`, `drizzle-orm/postgres-js`, `drizzle-orm/neon-*`) | `openDatabase(env)` |
  | a SQLSTATE read by hand (`err.code === '23505'`, `case '40001':`) | `isUniqueViolation(err)`, `pgErrorCode(err) === '40001'` |
  | session state outside a transaction: a statement `SET`, `set_config(…, false)`, `pg_advisory_lock`, `CREATE TEMP TABLE` | run it inside `db.transaction(…)` / `withTenantScope(…)`, or use the transaction-scoped form (`SET LOCAL`, `set_config(…, true)`, `pg_advisory_xact_lock`) |
  | `LISTEN` / `UNLISTEN` anywhere | a queue job or the `NotificationsHub` DO |

- **`tests/driver/` proves it**: the conformance suite, run by `pnpm test` under BOTH drivers on a
  local target (postgres, then neon through the local proxy) and under neon on a remote Neon
  branch. Each test states one equivalence and passes unchanged under both.

**A test that fails under one driver is a seam bug. Fix `client.ts` or the guard, never the
test.** Never skip it, `skipIf` it, or branch its expectation on the driver.
`tests/config/driver-conformance.test.ts` fails all three.

When you find a new divergence:
1. Reproduce it in `tests/driver/` as an equivalence that fails under one driver.
2. Normalise it in `client.ts` so both drivers give the same answer. If it cannot be normalised
   (a capability one driver lacks), add a rule to `driver-results.test.ts` that bans the pattern,
   with the replacement in its message and a row in the table above.
3. Record it in `docs/NEON-DRIVER.md` §5 and add a porting note, because a copy's own code may
   already contain the pattern.

Raw date/time values are Postgres's text under BOTH drivers: drizzle keeps them unparsed so its
column mappers can. Code reading a timestamp from raw SQL parses it itself (`new Date(value)`). The
query builder returns `Date`s under both.
