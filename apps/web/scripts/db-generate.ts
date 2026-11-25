/**
 * `pnpm db:generate` — `drizzle-kit generate`, then a scratch check: when it wrote a migration,
 * every migration is applied to a throwaway database on the local dev Postgres, which is dropped
 * afterwards. A migration Postgres refuses is reported in plain words while it is still unapplied
 * and editable (drizzle-kit can order a composite FOREIGN KEY before the UNIQUE it needs).
 *
 *   pnpm db:generate [drizzle-kit generate flags…]   # e.g. --name kit-mcp-server, --custom
 *   pnpm db:generate --check                          # only the scratch check, after a hand fix
 *
 * Never part of the gate. It never touches the dev database's own data, nor the test database: it
 * creates `<dev db>_gencheck_<random>` beside it and drops it. A non-local `DATABASE_URL` (a Neon
 * branch) skips the check with a note — creating databases there is not this script's call.
 * Exit 0 ok (or check skipped) · 1 drizzle-kit failed, or a migration does not apply.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { APP_ROLE } from '../src/db/schema/rls'
import {
  describeMigrationFailure,
  newMigrationFiles,
  scratchCheckRefusal,
  scratchDatabaseName,
  withDatabase,
} from './lib/migration-check'
import { runMigrations } from './migrate'

const WEB_DIR = path.resolve(import.meta.dirname, '..')
const MIGRATIONS = path.join(WEB_DIR, 'migrations')
const listMigrations = () => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))

async function scratchCheck(added: string[]): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  const refusal = scratchCheckRefusal(databaseUrl)
  if (refusal || !databaseUrl) {
    console.log(
      `· scratch check skipped: ${refusal} — read the new SQL before \`pnpm db:migrate\`.`
    )
    return 0
  }
  const name = scratchDatabaseName(databaseUrl, randomBytes(4).toString('hex'))
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 })
  try {
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`· scratch check skipped: could not create a scratch database (${message}).`)
      return 0
    }
    // Policies name the app role; it is cluster-wide, so it exists wherever `db:migrate` ran.
    // On a fresh cluster, create it the way `db-roles.ts` does (NOLOGIN, nothing granted).
    await admin.unsafe(
      `DO $do$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
           CREATE ROLE "${APP_ROLE}" NOLOGIN;
         END IF;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END $do$`
    )
    try {
      await runMigrations(withDatabase(databaseUrl, name), {
        migrationsFolder: MIGRATIONS,
        quiet: true,
        maxAttempts: 3,
        env: { DATABASE_DRIVER: 'postgres' },
      })
    } catch (error) {
      for (const line of describeMigrationFailure(error, added)) console.error(line)
      return 1
    }
    console.log(
      `✔ scratch check: all ${listMigrations().length} migrations apply to an empty database` +
        (added.length > 0 ? ` (new: ${added.join(', ')})` : '')
    )
    return 0
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
    await admin.end({ timeout: 5 })
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--check')) return scratchCheck([])
  const before = listMigrations()
  const generate = spawnSync('drizzle-kit', ['generate', ...argv], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (generate.status !== 0) return generate.status ?? 1
  const added = newMigrationFiles(before, listMigrations())
  if (added.length === 0) return 0
  return scratchCheck(added)
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  error => {
    console.error('db:generate failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
)
