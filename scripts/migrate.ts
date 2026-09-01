/**
 * Apply drizzle migrations (03 §4, D17). Node-only script — run via `pnpm db:migrate` (loads
 * .dev.vars) or `pnpm db:migrate:ci` (DATABASE_URL from the environment); tests import
 * `runMigrations` directly so they exercise the same path.
 *
 * Ported from the Workers reference app's `scripts/migrate.ts`: Neon `-pooler` host rewritten to the direct host
 * (DDL must never go through a transaction pooler — session state such as a stuck
 * `default_transaction_read_only` on a pooled backend once blocked a production deploy),
 * postgres.js `max: 1`, wait-for-database retry. The `@neondatabase/serverless` branch is gone
 * (D2): postgres.js over TCP reaches Neon's direct host fine.
 */
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export interface RunMigrationsOptions {
  /** Defaults to `./migrations` relative to cwd (drizzle.config.ts `out`). */
  migrationsFolder?: string
  /** Suppress progress output (tests). */
  quiet?: boolean
  /** Retry budget for `waitForDatabase` (1s apart). */
  maxAttempts?: number
}

export function isNeonUrl(url: string): boolean {
  return url.includes('.neon.tech')
}

/** `ep-xyz-pooler.region.aws.neon.tech` → `ep-xyz.region.aws.neon.tech`. */
export function toDirectNeonHost(connectionString: string): string {
  return connectionString.replace(/-pooler(?=\.[^/]*)/, '')
}

async function waitForDatabase(url: string, maxAttempts: number, log: (s: string) => void) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await sql`SELECT 1`
      return
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Database not ready after ${maxAttempts} attempts: ${String(error)}`)
      }
      if (attempt === 1) log('Waiting for database to be ready...')
      await new Promise(resolve => setTimeout(resolve, 1000))
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {})
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

  let url = databaseUrl
  if (isNeonUrl(url)) {
    const direct = toDirectNeonHost(url)
    log(direct === url ? 'Neon database' : 'Neon database (pooler bypassed — DDL runs direct)')
    url = direct
  }

  await waitForDatabase(url, options.maxAttempts ?? 30, log)

  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    // pgvector (D17) is required by the Phase 3 `documents`/`chunks` tables and must exist
    // before the first migration that references the `vector` type. Idempotent, and valid on
    // both Neon (extension available per branch) and the pgvector/pgvector:pg17 compose image.
    // It lives here rather than in a hand-written 0000 SQL file so the migrations folder stays
    // 100% drizzle-kit generated and works when it is still empty.
    await sql`CREATE EXTENSION IF NOT EXISTS vector`
    await migrate(drizzle(sql), { migrationsFolder })
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
    console.log('Running database migrations...')
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
