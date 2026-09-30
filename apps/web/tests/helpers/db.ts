/**
 * Test database harness (D15): the same `runMigrations` the deploy script uses, a shared pooled
 * handle via `getScriptDatabase`, and `cleanDatabase` that truncates every public table
 * (tolerating zero — Phase 0 has none). Guarded by `safetyCheck()` so it can never run against
 * anything but a localhost database under NODE_ENV=test (or an opted-in Neon gate branch).
 */
import { sql } from 'drizzle-orm'
import { closeAllDatabases, type Database, getScriptDatabase, rows } from '@/db/client'
import { runMigrations } from '../../scripts/migrate'
import { rememberRealDatabase } from '../kit/real-db'
import { checkTestDatabaseEnv } from './db-safety'

export function testDatabaseUrl(): string {
  safetyCheck()
  return process.env.DATABASE_URL as string
}

/**
 * Refuses unless NODE_ENV=test and the database is local Postgres — or, only under
 * `pnpm test` on a gate branch, a throwaway Neon GATE branch the caller names and binds to the URL
 * (`./db-safety.ts` has the rules and why each exists).
 */
export function safetyCheck(): void {
  checkTestDatabaseEnv(process.env)
}

/**
 * Shared pooled handle for fixtures/assertions (max 5 connections per fork).
 *
 * `rememberRealDatabase` is what makes the `@testkit/unit` builders able to refuse a handle nobody
 * handed out (D31). It is registered HERE rather than in the test kit's own entry so that the
 * blessing follows the HANDLE, whichever import path a test reached this function through — a kit
 * test importing `../helpers/db` and a plugin importing `@testkit/integration` get the same object
 * and the same answer.
 */
export function setupTestDatabase(): Database {
  return rememberRealDatabase(getScriptDatabase(testDatabaseUrl(), process.env))
}

/** Same code path as `pnpm db:migrate` — `CREATE EXTENSION vector` then drizzle migrate. */
export async function runTestMigrations(): Promise<void> {
  await runMigrations(testDatabaseUrl(), { quiet: true, maxAttempts: 15 })
}

/** TRUNCATE every table in `public` (drizzle's bookkeeping lives in schema `drizzle`). */
export async function cleanDatabase(db: Database): Promise<void> {
  safetyCheck()
  const tables = rows<{ ident: string }>(
    await db.execute(sql`
      SELECT quote_ident(table_name::text) AS ident
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`)
  )
  if (tables.length === 0) return
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tables.map(r => r.ident).join(', ')} RESTART IDENTITY CASCADE`)
  )
}

export async function closeTestDatabases(): Promise<void> {
  await closeAllDatabases()
}
