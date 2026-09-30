/**
 * Drizzle over one of two drivers (D35), picked by `DATABASE_DRIVER`:
 *
 * - `postgres` (a missing var means this): postgres.js. In the Worker, Hyperdrive is the real pool,
 *   so `max: 1` and `prepare: false` (transaction-mode pooler). Locally, TCP to the compose Postgres.
 * - `neon`: the Neon serverless driver. Queries go over HTTP (one round trip each); `transaction`
 *   opens a WebSocket `Pool` on first use, because neon-http cannot run interactive transactions.
 *   `NEON_LOCAL_PROXY` points both at a local proxy in front of the compose Postgres.
 *
 * A client is created per request/invocation and closed with the handle (middleware/database.ts).
 * Code outside this file sees `Database` — the base both drivers share — and reads raw `execute()`
 * results through `rows()` / `affected()`, never a driver's own shape.
 *
 * **This file is the driver seam** (src/db/CLAUDE.md, "The driver seam"): the ONLY place the two
 * drivers differ. Every divergence is either normalised here — a raw result's shape (`rows()`,
 * `affected()`), a raw array's value (`ARRAY_PARSERS`), a driver error's code (`pgErrorCode()`) —
 * or banned outside it by `tests/config/driver-results.test.ts`, and `tests/driver/` proves the
 * result under both drivers in every gate.
 */
import { Pool as NeonPool, neon, neonConfig, types as neonTypes } from '@neondatabase/serverless'
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http'
import { drizzle as drizzleNeonPool } from 'drizzle-orm/neon-serverless'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

export type DatabaseDriver = 'neon' | 'postgres'
export const DATABASE_DRIVERS = ['neon', 'postgres'] as const

export interface DatabaseHandle {
  db: Database
  /** Ends the underlying client (and, under `neon`, the transaction pool). Idempotent. */
  close(): Promise<void>
}

export interface CreateDatabaseOptions {
  /** Connections per client. 1 in the Worker (Hyperdrive / Neon pool), 5 for scripts/tests. */
  max?: number
}

/**
 * What `openDatabase` reads — structural, so `AppConfig` plus the bindings, a script's
 * `process.env` and a test's plain object all fit.
 */
export interface DatabaseEnv {
  /** `neon | postgres`; missing or empty means `postgres`, so a copy that never set it is unchanged. */
  DATABASE_DRIVER?: string
  HYPERDRIVE?: { connectionString: string }
  PREVIEW_DATABASE_URL?: string
  DATABASE_URL?: string
  /** Local only: the Neon proxy in front of the compose Postgres (`http://localhost:4444`). */
  NEON_LOCAL_PROXY?: string
}

/** The driver `env` selects. Throws on a value that is neither, rather than guessing. */
export function databaseDriver(env: Pick<DatabaseEnv, 'DATABASE_DRIVER'>): DatabaseDriver {
  const value = env.DATABASE_DRIVER?.trim()
  if (!value) return 'postgres'
  if (value === 'neon' || value === 'postgres') return value
  throw new Error(`DATABASE_DRIVER must be neon or postgres, got "${value}"`)
}

/**
 * The connection string for the selected driver:
 *
 * - `postgres`: `PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL`. Preview
 *   deployments (a per-PR Neon branch) bypass the shared Hyperdrive binding; `wrangler dev`
 *   supplies Hyperdrive's `localConnectionString` when the toml has the block.
 * - `neon`: `PREVIEW_DATABASE_URL ?? DATABASE_URL` (the pooled Neon URI). `HYPERDRIVE` is ignored.
 */
export function resolveDatabaseUrl(env: DatabaseEnv): string {
  const driver = databaseDriver(env)
  const url =
    driver === 'neon'
      ? env.PREVIEW_DATABASE_URL || env.DATABASE_URL
      : env.PREVIEW_DATABASE_URL || env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) {
    throw new Error(
      driver === 'neon'
        ? 'No database connection available: DATABASE_DRIVER=neon needs the DATABASE_URL secret'
        : 'No database connection available: set the HYPERDRIVE binding or DATABASE_URL secret'
    )
  }
  return url
}

/** Open a handle for one request/invocation with the driver and URL `env` selects. */
export function openDatabase(
  env: DatabaseEnv,
  options: Omit<CreateNeonDatabaseOptions, 'localProxy'> = {}
): DatabaseHandle {
  const url = resolveDatabaseUrl(env)
  return databaseDriver(env) === 'neon'
    ? createNeonDatabase(url, { ...options, localProxy: env.NEON_LOCAL_PROXY })
    : createDatabase(url, options)
}

/**
 * A postgres.js handle. postgres.js connects lazily, so a handle that never runs a query costs
 * nothing and `close()` returns immediately.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 1,
    // Hyperdrive and other transaction-mode poolers do not support named prepared
    // statements across queries; unnamed (per-query) is the only safe mode.
    prepare: false,
    // Skips the startup round-trip that lists custom types; the kit only uses builtins
    // (pgvector's `vector` is sent/received as text by drizzle).
    fetch_types: false,
    onnotice: () => {},
  })
  const db = drizzlePostgres(client, { schema }) as unknown as Database
  // After drizzle, which installs its own transparent parsers for the date types on the same map.
  Object.assign(client.options.parsers, ARRAY_PARSERS)
  let closed: Promise<void> | undefined
  return {
    db,
    close: () => {
      closed ??= client.end({ timeout: 5 }).catch(() => {})
      return closed
    },
  }
}

/**
 * Raw Postgres arrays, parsed the way the Neon driver parses them — with Neon's OWN parsers, so the
 * two cannot drift. postgres.js runs with `fetch_types: false` (no startup round trip per
 * request), which skips its array-type lookup, so without this a raw `text[]` arrived as the
 * literal `"{x,y}"` under `postgres` and as `['x','y']` under `neon`. The date and interval arrays
 * (1115, 1182, 1185, 1187) and `numeric[]` (1231) are absent on purpose: drizzle keeps those as
 * strings under BOTH drivers, and its column mappers expect that.
 */
const ARRAY_OIDS = [
  199, // json[]
  1000, // bool[]
  1001, // bytea[]
  1005, // int2[]
  1007, // int4[]
  1009, // text[]
  1014, // bpchar[]
  1015, // varchar[]
  1016, // int8[] (strings, like a scalar bigint)
  1021, // float4[]
  1022, // float8[]
  1028, // oid[]
  1040, // macaddr[]
  1041, // inet[]
  1183, // time[]
  1270, // timetz[]
  2951, // uuid[]
  3807, // jsonb[]
] as const
const ARRAY_PARSERS: Record<number, (value: string) => unknown> = Object.fromEntries(
  ARRAY_OIDS.map(oid => [oid, neonTypes.getTypeParser(oid, 'text')])
)

export interface CreateNeonDatabaseOptions extends CreateDatabaseOptions {
  /** `NEON_LOCAL_PROXY`: route HTTP and WebSocket through a local proxy instead of Neon. */
  localProxy?: string
  /**
   * Every query over the WebSocket pool, none over HTTP. For long-lived Node handles (scripts,
   * test fixtures) that run thousands of queries: one held connection beats a connection per
   * query, which the local proxy pays in full (~75 ms each). The Worker never sets it.
   */
  poolOnly?: boolean
}

/**
 * A Neon handle: neon-http for every query, and a WebSocket `Pool` for `transaction`, created on
 * first use and ended by `close()`. The HTTP side holds no connection, so an idle handle costs
 * nothing.
 */
export function createNeonDatabase(
  url: string,
  options: CreateNeonDatabaseOptions = {}
): DatabaseHandle {
  if (options.localProxy) routeNeonThroughProxy(options.localProxy)
  let pool: NeonPool | undefined
  let poolDb: Database | undefined
  const transactional = (): Database => {
    if (!poolDb) {
      pool = new NeonPool({ connectionString: url, max: options.max ?? 1 })
      poolDb = drizzleNeonPool(pool, { schema }) as unknown as Database
    }
    return poolDb
  }
  let closed: Promise<void> | undefined
  const close = () => {
    closed ??= pool ? pool.end().catch(() => {}) : Promise.resolve()
    return closed
  }
  if (options.poolOnly) return { db: transactional(), close }

  const db = drizzleNeonHttp(neon(url), { schema }) as unknown as Database
  // neon-http's own `transaction` throws; the pool's is a real interactive transaction.
  db.transaction = ((...args: Parameters<Database['transaction']>) =>
    transactional().transaction(...args)) as Database['transaction']
  return { db, close }
}

/**
 * Point the Neon driver at a local proxy (`http://localhost:4444`): HTTP queries to `/sql`,
 * WebSockets to `/v2`, both unencrypted. `neonConfig` is per-isolate, and the proxy is one value
 * per process, so setting it globally is safe.
 */
export function routeNeonThroughProxy(proxy: string): void {
  const target = new URL(proxy)
  neonConfig.fetchEndpoint = `${target.origin}/sql`
  neonConfig.wsProxy = () => `${target.host}/v2`
  neonConfig.useSecureWebSocket = target.protocol === 'https:'
  neonConfig.pipelineConnect = false
}

// ---- Reading raw results -------------------------------------------------------------------

type QueryResultLike = { rows?: unknown; rowCount?: unknown; count?: unknown }

/**
 * The rows of a raw `db.execute(sql…)`, whichever driver ran it: postgres.js returns the array
 * itself, Neon a `{ rows }` object. The only way code outside this file reads one (the config
 * guard `driver-results.test.ts` enforces it).
 */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const candidate = (result as QueryResultLike | null)?.rows
  if (Array.isArray(candidate)) return candidate as T[]
  throw new TypeError('rows(): not a query result')
}

/**
 * The number of rows an `insert` / `update` / `delete` without `.returning()` touched: postgres.js
 * reports `.count`, Neon `.rowCount`.
 */
export function affected(result: unknown): number {
  const r = (result ?? {}) as QueryResultLike
  const value = typeof r.rowCount === 'number' ? r.rowCount : r.count
  return typeof value === 'number' ? value : 0
}

// ---- Reading driver errors -----------------------------------------------------------------

/**
 * The Postgres SQLSTATE (`23505`, `40001`…) of a driver error, wherever it hangs: both drivers put
 * `code` on their own error (postgres.js, Neon's `NeonDbError`) and drizzle wraps that, so the
 * `cause` chain is walked. The only way code outside this file reads one (the config guard
 * `driver-results.test.ts` enforces it).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current = err
  for (let depth = 0; current && depth < 5; depth++) {
    const code = typeof current === 'object' ? (current as { code?: unknown }).code : undefined
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A unique / primary-key violation (`23505`), under either driver. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505'
}

// ---- Node-side (scripts/tests) -------------------------------------------------------------

/** Every handle from `getScriptDatabase`, so `closeAllDatabases()` ends all of them. */
const scriptHandles = new Map<string, DatabaseHandle>()

/**
 * A pooled handle for scripts and tests (max 5), memoised per driver and URL. `env` carries the
 * driver vars — a script passes `process.env`, where `.dev.vars` / `.env.test` put them; this file
 * never reads `process` itself. Not for the Worker — the request path must go through
 * `openDatabase` so the client is ended per request.
 */
export function getScriptDatabase(
  url: string,
  env: { readonly [key: string]: string | undefined } = {},
  max = 5
): Database {
  const scoped: DatabaseEnv = {
    DATABASE_DRIVER: env.DATABASE_DRIVER,
    NEON_LOCAL_PROXY: env.NEON_LOCAL_PROXY,
    DATABASE_URL: url,
  }
  const key = `${databaseDriver(scoped)} ${url}`
  let handle = scriptHandles.get(key)
  if (!handle) {
    handle = openDatabase(scoped, { max, poolOnly: true })
    scriptHandles.set(key, handle)
  }
  return handle.db
}

/** Test teardown: end every script handle. Safe to call repeatedly. */
export async function closeAllDatabases(): Promise<void> {
  const handles = [...scriptHandles.values()]
  scriptHandles.clear()
  await Promise.all(handles.map(h => h.close()))
}
