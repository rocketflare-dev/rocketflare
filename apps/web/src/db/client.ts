/**
 * Drizzle over postgres.js — the ONLY driver (D2). In the Worker a client is created per
 * request/invocation and ended in `waitUntil` (see middleware/database.ts); Hyperdrive is the
 * real pool, so `max: 1` and `prepare: false` (transaction-mode pooler). Ported from
 * the Workers reference app's `src/db/client.ts` + `middleware/database.ts`, minus the Neon HTTP branch.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = PostgresJsDatabase<typeof schema>

export interface DatabaseHandle {
  db: Database
  /** Ends the underlying postgres.js client. Idempotent. */
  close(): Promise<void>
}

export interface CreateDatabaseOptions {
  /** Connections per client. 1 in the Worker (Hyperdrive pools), 5 for scripts/tests. */
  max?: number
  /** Postgres NOTICE sink. Default drops them (postgres.js would console.log each one). */
  onnotice?: (notice: postgres.Notice) => void
}

/** The env shape the URL resolver needs — structural so scripts and tests can pass plain objects. */
export interface DatabaseEnv {
  HYPERDRIVE?: { connectionString: string }
  PREVIEW_DATABASE_URL?: string
  DATABASE_URL?: string
}

/**
 * `PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL`.
 *
 * Preview deployments (per-PR Neon branch) must bypass the shared Hyperdrive binding; in
 * `wrangler dev` Hyperdrive supplies `localConnectionString`; `DATABASE_URL` is the last
 * resort (tests, scripts, a Worker without the binding).
 */
export function resolveDatabaseUrl(env: DatabaseEnv): string {
  const url = env.PREVIEW_DATABASE_URL || env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) {
    throw new Error(
      'No database connection available: set the HYPERDRIVE binding or DATABASE_URL secret'
    )
  }
  return url
}

/**
 * Create a drizzle handle for one request/invocation. postgres.js connects lazily, so a
 * handle that never runs a query costs nothing and `close()` returns immediately.
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
    onnotice: options.onnotice ?? (() => {}),
  })
  let closed: Promise<void> | undefined
  return {
    db: drizzle(client, { schema }),
    close: () => {
      closed ??= client.end({ timeout: 5 }).catch(() => {})
      return closed
    },
  }
}

// ---- Node-side (scripts/tests) -------------------------------------------------------------

/** Every handle from `getScriptDatabase`, so `closeAllDatabases()` ends all of them. */
const scriptHandles = new Map<string, DatabaseHandle>()

/**
 * A pooled handle for scripts and tests (max 5), memoised per URL. Not for the Worker —
 * the request path must go through `createDatabase` so the client is ended per request.
 */
export function getScriptDatabase(url: string, max = 5): Database {
  let handle = scriptHandles.get(url)
  if (!handle) {
    handle = createDatabase(url, { max })
    scriptHandles.set(url, handle)
  }
  return handle.db
}

/** Test teardown: end every script handle. Safe to call repeatedly. */
export async function closeAllDatabases(): Promise<void> {
  const handles = [...scriptHandles.values()]
  scriptHandles.clear()
  await Promise.all(handles.map(h => h.close()))
}
