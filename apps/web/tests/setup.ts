/**
 * Global test setup (D15) — runs once per vitest project before the api suites:
 * roles (phase=role) → migrations → roles (phase=grants) → clean → seed one owner/tenant/API
 * key/session, exposed to tests as `inject('seed')` (`TestSeed` in helpers/auth.ts).
 *
 * Two projects (`api`, `api-isolated`) name this file and vitest calls a globalSetup ONCE PER
 * PROJECT, re-importing the module, so a module-level flag would not dedupe. The memo hangs
 * off `globalThis` — the only thing the two module instances share — and holds the seed so the
 * second project `provide()`s the same rows instead of inserting duplicates.
 */
import { applyDbRoles } from '../scripts/db-roles'
import { seedTestFixtures, type TestSeed } from './helpers/auth'
import {
  cleanDatabase,
  closeTestDatabases,
  runTestMigrations,
  setupTestDatabase,
} from './helpers/db'

const MEMO = Symbol.for('rocketflare.tests.globalSetup')
type MemoHost = typeof globalThis & { [MEMO]?: Promise<TestSeed> }

export default async function setup(context: {
  provide: <K extends 'seed'>(key: K, value: TestSeed) => void
}) {
  const host = globalThis as MemoHost
  host[MEMO] ??= prepareTestDatabase()
  const seed = await host[MEMO]
  context.provide('seed', seed)

  return async () => {
    await closeTestDatabases()
  }
}

async function prepareTestDatabase(): Promise<TestSeed> {
  // The role RLS policies target must exist before a migration can reference it. With
  // APP_DATABASE_URL unset the role is created NOLOGIN and the policies are inert.
  await applyDbRoles({ phase: 'role', quiet: true })
  await runTestMigrations()
  // Grants + REVOKE of the infrastructure tables, only now that the tables exist.
  await applyDbRoles({ phase: 'grants', quiet: true })
  const db = setupTestDatabase()
  await cleanDatabase(db)
  return seedTestFixtures(db)
}
