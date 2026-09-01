/**
 * Global test setup (D15) — runs once per vitest project before the api suites:
 * roles (phase=role) → migrations → roles (phase=grants) → clean. Nothing is `provide()`d yet;
 * Phase 1 seeds a global user/tenant/API key here as the reference app does.
 *
 * Two projects (`api`, `api-isolated`) name this file and vitest calls a globalSetup ONCE PER
 * PROJECT, re-importing the module, so a module-level flag would not dedupe. The memo hangs
 * off `globalThis` — the only thing the two module instances share.
 */
import { applyDbRoles } from '../scripts/db-roles'
import {
  cleanDatabase,
  closeTestDatabases,
  runTestMigrations,
  setupTestDatabase,
} from './helpers/db'

const MEMO = Symbol.for('gmgo.tests.globalSetup')
type MemoHost = typeof globalThis & { [MEMO]?: Promise<void> }

export default async function setup(_context: { provide: (key: string, value: unknown) => void }) {
  const host = globalThis as MemoHost
  host[MEMO] ??= prepareTestDatabase()
  await host[MEMO]

  return async () => {
    await closeTestDatabases()
  }
}

async function prepareTestDatabase(): Promise<void> {
  // The role RLS policies target must exist before a migration can reference it. With
  // APP_DATABASE_URL unset the role is created NOLOGIN and the policies are inert.
  await applyDbRoles({ phase: 'role', quiet: true })
  await runTestMigrations()
  // Grants + REVOKE of the infrastructure tables, only now that the tables (may) exist.
  await applyDbRoles({ phase: 'grants', quiet: true })
  await cleanDatabase(setupTestDatabase())
}
