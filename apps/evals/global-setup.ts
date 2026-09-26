/**
 * Once per `pnpm eval`: bring the TEST database (:5433, `apps/web/.env.test`) to the current schema —
 * roles → migrations → grants, the web suite's own sequence — without truncating it, so an eval run
 * and a test run can share the database. `safetyCheck()` inside `testDatabaseUrl()` refuses anything
 * but localhost under `NODE_ENV=test`.
 */
import path from 'node:path'
import { applyDbRoles } from '../web/scripts/db-roles'
import { runMigrations } from '../web/scripts/migrate'
import { closeTestDatabases, testDatabaseUrl } from '../web/tests/helpers/db'

export default async function setup() {
  await applyDbRoles({ phase: 'role', quiet: true })
  await runMigrations(testDatabaseUrl(), {
    quiet: true,
    maxAttempts: 15,
    // The migrator resolves a relative folder against the cwd, which here is apps/evals.
    migrationsFolder: path.resolve(__dirname, '../web/migrations'),
  })
  await applyDbRoles({ phase: 'grants', quiet: true })
  return async () => {
    await closeTestDatabases()
  }
}
