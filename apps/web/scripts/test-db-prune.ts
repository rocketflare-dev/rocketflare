/**
 * `pnpm test:db:prune [--dry-run]` — drop the per-checkout TEST databases whose checkout is gone
 * (`scripts/lib/test-db.mjs`, docs/CONCEPTS.md §4). Every checkout's first test run creates
 * `<.env.test's database>_<hash>` in the shared test Postgres and labels it with the checkout's
 * path; a removed worktree leaves its database behind. This lists every labelled database, marks
 * the ones whose path no longer exists, and drops those (`--dry-run`: only lists). A database
 * without the label — the compose default, anything made by hand or by another tool — is never
 * listed and never dropped.
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  checkoutDatabaseName,
  checkoutPath,
  ENV_TEST_FILE,
  envTestDatabaseName,
  planPrune,
} from '../../../scripts/lib/test-db.mjs'
import { openScriptSql } from './lib/sql'

const dryRun = process.argv.includes('--dry-run')
const envTest = readFileSync(ENV_TEST_FILE, 'utf8')
const raw = /^DATABASE_URL=(\S+)/m.exec(envTest)?.[1]
const base = envTestDatabaseName(envTest)
if (!raw || !base) {
  console.error(`✖ ${ENV_TEST_FILE} names no DATABASE_URL`)
  process.exit(1)
}
const admin = new URL(raw)
admin.pathname = '/postgres'
const sql = openScriptSql(admin.toString(), { DATABASE_DRIVER: 'postgres' }, { connectTimeout: 5 })
try {
  const databases = await sql.query<{ name: string; comment: string | null }>(
    `SELECT d.datname AS name, shobj_description(d.oid, 'pg_database') AS comment
     FROM pg_database d ORDER BY d.datname`
  )
  const { live, stale } = planPrune(databases, existsSync)
  const ours = checkoutDatabaseName(base, checkoutPath())
  console.log(`test databases on ${admin.host} (${live.length + stale.length} per-checkout):`)
  for (const db of live) {
    console.log(`  keep  ${db.name}  ${db.checkout}${db.name === ours ? '  (this checkout)' : ''}`)
  }
  for (const db of stale) console.log(`  ${dryRun ? 'stale' : 'drop '} ${db.name}  ${db.checkout}`)
  if (!dryRun) {
    for (const db of stale) {
      // FORCE: a run killed mid-suite can leave a connection open; the checkout is gone either way.
      await sql.query(`DROP DATABASE IF EXISTS "${db.name.replaceAll('"', '""')}" WITH (FORCE)`)
    }
  }
  console.log(
    stale.length === 0
      ? '✔ nothing to prune'
      : dryRun
        ? `· ${stale.length} stale — run without --dry-run to drop them`
        : `✔ dropped ${stale.length}`
  )
} catch (error) {
  console.error(
    `✖ cannot reach the test Postgres at ${admin.host}: ${(error as Error).message}. ` +
      '`pnpm test:db:up` starts it.'
  )
  process.exitCode = 1
} finally {
  await sql.end()
}
