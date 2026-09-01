/**
 * `pnpm db:check` — connect with DATABASE_URL, print server version + current role, exit 0/1.
 * First thing to run when `pnpm dev` cannot reach Postgres.
 */
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} })
  try {
    const [row] = await sql<{ version: string; role: string; db: string; vector: boolean }[]>`
      SELECT version() AS version,
             current_user AS role,
             current_database() AS db,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector`
    if (!row) throw new Error('empty result')
    console.log(`Connected to ${row.db} as ${row.role}`)
    console.log(row.version)
    console.log(
      `pgvector extension: ${row.vector ? 'installed' : 'not installed (migrate.ts creates it)'}`
    )
    process.exit(0)
  } catch (error) {
    console.error('Database connection failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
}

main()
