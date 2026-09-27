/**
 * Apply drizzle migrations (03 §4, D17). Node-only script — run via `pnpm db:migrate` (loads
 * .dev.vars) or `pnpm db:migrate:ci` (DATABASE_URL from the environment); tests import
 * `runMigrations` directly so they exercise the same path.
 *
 * Ported from the Workers reference app's `scripts/migrate.ts`: Neon `-pooler` host rewritten to
 * the direct host (DDL must never go through a transaction pooler — session state such as a stuck
 * `default_transaction_read_only` on a pooled backend once blocked a production deploy), one
 * connection, wait-for-database retry. The driver follows `DATABASE_DRIVER` (D35,
 * `scripts/lib/sql.ts`): postgres.js over TCP, or a Neon `Pool` over WebSocket where there is no
 * TCP out (a coding sandbox on a Neon branch).
 */
import { fileURLToPath } from 'node:url'
import { Pool as NeonPool } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { migrate as migrateNeon } from 'drizzle-orm/neon-serverless/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { isNeonUrl, openScriptSql, scriptDriver, toDirectNeonHost } from './lib/sql'

export { isNeonUrl, toDirectNeonHost }

export interface RunMigrationsOptions {
  /** Defaults to `./migrations` relative to cwd (drizzle.config.ts `out`). */
  migrationsFolder?: string
  /** Suppress progress output (tests). */
  quiet?: boolean
  /** Retry budget for `waitForDatabase` (1s apart). */
  maxAttempts?: number
  /** Where `DATABASE_DRIVER` / `NEON_LOCAL_PROXY` are read from. Default `process.env`. */
  env?: { readonly [key: string]: string | undefined }
}

async function waitForDatabase(
  url: string,
  env: RunMigrationsOptions['env'],
  maxAttempts: number,
  log: (s: string) => void
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sql = openScriptSql(url, env)
    try {
      await sql.query('SELECT 1')
      return
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Database not ready after ${maxAttempts} attempts: ${String(error)}`)
      }
      if (attempt === 1) log('Waiting for database to be ready...')
      await new Promise(resolve => setTimeout(resolve, 1000))
    } finally {
      await sql.end()
    }
  }
}

/**
 * Run all pending migrations against `databaseUrl`. Works with an EMPTY `migrations/` folder
 * (drizzle needs `meta/_journal.json` with `entries: []`, which is committed).
 */
export async function runMigrations(
  databaseUrl: string,
  options: RunMigrationsOptions = {}
): Promise<void> {
  const log = options.quiet ? () => {} : (s: string) => console.log(s)
  const migrationsFolder = options.migrationsFolder ?? './migrations'
  const env = options.env ?? process.env

  let url = databaseUrl
  if (isNeonUrl(url)) {
    const direct = toDirectNeonHost(url)
    log(direct === url ? 'Neon database' : 'Neon database (pooler bypassed — DDL runs direct)')
    url = direct
  }

  await waitForDatabase(url, env, options.maxAttempts ?? 30, log)

  // pgvector (D17) is required by the Phase 3 `documents`/`chunks` tables and must exist
  // before the first migration that references the `vector` type. Idempotent, and valid on
  // both Neon (extension available per branch) and the pgvector/pgvector:pg17 compose image.
  // It lives here rather than in a hand-written 0000 SQL file so the migrations folder stays
  // 100% drizzle-kit generated and works when it is still empty.
  const createVector = 'CREATE EXTENSION IF NOT EXISTS vector'

  if (scriptDriver(env) === 'neon') {
    const sql = openScriptSql(url, env) // routes through NEON_LOCAL_PROXY when set
    const pool = new NeonPool({ connectionString: url, max: 1 })
    try {
      await sql.query(createVector)
      await migrateNeon(drizzleNeon(pool), { migrationsFolder })
      log('Migrations applied')
    } finally {
      await pool.end().catch(() => {})
      await sql.end()
    }
    return
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(createVector)
    await migratePostgres(drizzlePostgres(sql), { migrationsFolder })
    log('Migrations applied')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }
  try {
    console.log(`Running database migrations (${scriptDriver()} driver)...`)
    await runMigrations(databaseUrl)
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

// Only run as a CLI — tests/helpers/db.ts imports runMigrations directly.
const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
}
