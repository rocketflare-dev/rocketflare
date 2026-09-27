/**
 * Raw SQL for the Node scripts (migrate, db-roles, db:check, provision), over the driver
 * `DATABASE_DRIVER` selects (D35) — the same var the Worker reads, which `.dev.vars` sets locally.
 *
 * - `postgres` (missing means this): postgres.js over TCP.
 * - `neon`: a Neon serverless `Pool`, which needs only a WebSocket, so a coding sandbox with no
 *   TCP out can still migrate and seed a Neon branch. `NEON_LOCAL_PROXY` routes it through the
 *   local proxy.
 *
 * Queries are text + `$n` parameters, identical on both drivers.
 */
import { Pool as NeonPool } from '@neondatabase/serverless'
import postgres from 'postgres'
import { type DatabaseDriver, databaseDriver, routeNeonThroughProxy } from '../../src/db/client'

export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>

export interface ScriptSql {
  driver: DatabaseDriver
  query: Query
  /** `BEGIN` … `COMMIT` on one connection; `ROLLBACK` when `fn` throws. */
  transaction(fn: (query: Query) => Promise<void>): Promise<void>
  end(): Promise<void>
}

export interface ScriptSqlOptions {
  /** Seconds to wait for a connection (postgres.js `connect_timeout`). */
  connectTimeout?: number
}

type DriverEnv = { readonly [key: string]: string | undefined }

/** The driver the scripts use: `DATABASE_DRIVER` from the environment, missing → `postgres`. */
export function scriptDriver(env: DriverEnv = process.env): DatabaseDriver {
  return databaseDriver({ DATABASE_DRIVER: env.DATABASE_DRIVER })
}

export function openScriptSql(
  url: string,
  env: DriverEnv = process.env,
  options: ScriptSqlOptions = {}
): ScriptSql {
  return scriptDriver(env) === 'neon' ? neonSql(url, env) : postgresSql(url, options)
}

function postgresSql(url: string, options: ScriptSqlOptions): ScriptSql {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    ...(options.connectTimeout ? { connect_timeout: options.connectTimeout } : {}),
  })
  const run =
    (target: postgres.Sql | postgres.TransactionSql): Query =>
    async (text, params = []) =>
      (await target.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as never
  return {
    driver: 'postgres',
    query: run(sql),
    transaction: async fn => {
      await sql.begin(async tx => {
        await fn(run(tx))
      })
    },
    end: () => sql.end({ timeout: 5 }).catch(() => {}),
  }
}

function neonSql(url: string, env: DriverEnv): ScriptSql {
  if (env.NEON_LOCAL_PROXY) routeNeonThroughProxy(env.NEON_LOCAL_PROXY)
  const pool = new NeonPool({ connectionString: url, max: 1 })
  return {
    driver: 'neon',
    query: async (text, params = []) => (await pool.query(text, params)).rows as never,
    transaction: async fn => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await fn(async (text, params = []) => (await client.query(text, params)).rows as never)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },
    end: () => pool.end().catch(() => {}),
  }
}

/** Neon: DDL and role changes target the direct host, never the `-pooler` one. */
export function isNeonUrl(url: string): boolean {
  return url.includes('.neon.tech')
}

/** `ep-xyz-pooler.region.aws.neon.tech` → `ep-xyz.region.aws.neon.tech`. */
export function toDirectNeonHost(connectionString: string): string {
  return connectionString.replace(/-pooler(?=\.[^/]*)/, '')
}
