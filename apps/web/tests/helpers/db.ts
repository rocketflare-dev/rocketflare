/**
 * Test database harness (D15): the same `runMigrations` the deploy script uses, a shared pooled
 * handle via `getScriptDatabase`, and `cleanDatabase` that truncates every public table
 * (tolerating zero — Phase 0 has none). Guarded by `safetyCheck()` so it can never run against
 * anything but a localhost database under NODE_ENV=test.
 */
import { sql } from 'drizzle-orm'
import { closeAllDatabases, type Database, getScriptDatabase } from '@/db/client'
import { runMigrations } from '../../scripts/migrate'

export function testDatabaseUrl(): string {
  safetyCheck()
  return process.env.DATABASE_URL as string
}

/**
 * 1. NODE_ENV must be 'test'; 2. DATABASE_URL must be localhost; 3. APP_DATABASE_URL, if set,
 * must be localhost too — it is a second way to reach a database.
 */
export function safetyCheck(): void {
  const { NODE_ENV, DATABASE_URL, APP_DATABASE_URL } = process.env
  if (NODE_ENV !== 'test') {
    throw new Error(
      `SAFETY CHECK FAILED: NODE_ENV must be 'test' (current: ${NODE_ENV ?? 'undefined'})`
    )
  }
  if (!DATABASE_URL) throw new Error('SAFETY CHECK FAILED: DATABASE_URL is not set')
  if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL)) {
    throw new Error(
      `SAFETY CHECK FAILED: DATABASE_URL must be local Postgres. Current: ${DATABASE_URL}`
    )
  }
  if (APP_DATABASE_URL && !/localhost|127\.0\.0\.1/.test(APP_DATABASE_URL)) {
    throw new Error(
      `SAFETY CHECK FAILED: APP_DATABASE_URL must be local Postgres. Current: ${APP_DATABASE_URL}`
    )
  }
}

/** Shared pooled handle for fixtures/assertions (max 5 connections per fork). */
export function setupTestDatabase(): Database {
  return getScriptDatabase(testDatabaseUrl())
}

/** Same code path as `pnpm db:migrate` — `CREATE EXTENSION vector` then drizzle migrate. */
export async function runTestMigrations(): Promise<void> {
  await runMigrations(testDatabaseUrl(), { quiet: true, maxAttempts: 15 })
}

/** TRUNCATE every table in `public` (drizzle's bookkeeping lives in schema `drizzle`). */
export async function cleanDatabase(db: Database): Promise<void> {
  safetyCheck()
  const rows = (await db.execute(sql`
    SELECT quote_ident(table_name::text) AS ident
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`)) as unknown as Array<{ ident: string }>
  if (rows.length === 0) return
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${rows.map(r => r.ident).join(', ')} RESTART IDENTITY CASCADE`)
  )
}

export async function closeTestDatabases(): Promise<void> {
  await closeAllDatabases()
}
