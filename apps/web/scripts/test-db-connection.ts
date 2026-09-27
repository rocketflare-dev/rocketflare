/**
 * `pnpm db:check` — connect with DATABASE_URL over the `DATABASE_DRIVER` driver (D35), print server
 * version + current role, exit 0/1. First thing to run when `pnpm dev` cannot reach Postgres.
 */
import { openScriptSql } from './lib/sql'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }
  const sql = openScriptSql(url, process.env, { connectTimeout: 10 })
  try {
    const [row] = await sql.query<{ version: string; role: string; db: string; vector: boolean }>(
      `SELECT version() AS version,
              current_user AS role,
              current_database() AS db,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector`
    )
    if (!row) throw new Error('empty result')
    console.log(`Connected to ${row.db} as ${row.role} (${sql.driver} driver)`)
    console.log(row.version)
    console.log(
      `pgvector extension: ${row.vector ? 'installed' : 'not installed (migrate.ts creates it)'}`
    )
    process.exit(0)
  } catch (error) {
    console.error('Database connection failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
