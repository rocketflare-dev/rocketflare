/**
 * The pure half of `pnpm db:generate`'s scratch check (`scripts/db-generate.ts`): which migration
 * files a generate run added, the throwaway database's URL, and the plain-words report of a
 * migration Postgres refused. Unit-tested in `tests/config/migration-check.test.ts`.
 *
 * Why the check exists: drizzle-kit can write a statement before the one it depends on — a
 * composite FOREIGN KEY ahead of the UNIQUE it references, in the same migration — and the
 * failure only shows when someone applies it. Applying every migration to an EMPTY scratch
 * database right after generating catches it while the file is still unapplied and editable.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The `NNNN_*.sql` files in `after` that were not in `before`, sorted. */
export function newMigrationFiles(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before)
  return after.filter(f => /^\d{4}_.+\.sql$/.test(f) && !seen.has(f)).sort()
}

/**
 * Where the scratch check may run: a local Postgres only. It creates and drops a database, which
 * a hosted branch (Neon) may refuse and should never be asked to do on a person's behalf.
 */
export function scratchCheckRefusal(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return 'DATABASE_URL is not set (apps/web/.dev.vars)'
  let host: string
  try {
    host = new URL(databaseUrl).hostname.toLowerCase()
  } catch {
    return 'DATABASE_URL is not a URL'
  }
  if (!LOCAL_HOSTS.has(host)) return `DATABASE_URL points at ${host}, not a local Postgres`
  return null
}

/** A database name nobody else uses: `<dev db>_gencheck_<suffix>`, kept within 63 bytes. */
export function scratchDatabaseName(databaseUrl: string, suffix: string): string {
  const base = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) || 'postgres'
  const clean = base.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  const tail = `_gencheck_${suffix.replace(/[^a-z0-9]/gi, '').toLowerCase()}`
  return `${clean.slice(0, 63 - tail.length)}${tail}`
}

/** `databaseUrl` with its database swapped for `name`. */
export function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}

interface ErrorLike {
  message?: unknown
  code?: unknown
  detail?: unknown
  hint?: unknown
  cause?: unknown
}

/**
 * What to print when the migrations do not apply to an empty database: the new files, what
 * Postgres said (the innermost cause — drizzle wraps it as `Failed query: …`), the statement, and
 * what to do about it.
 */
export function describeMigrationFailure(error: unknown, added: readonly string[]): string[] {
  const chain: ErrorLike[] = []
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    chain.push(current as ErrorLike)
    current = (current as ErrorLike).cause
  }
  const root = chain.at(-1) ?? { message: String(error) }
  const top = chain[0] ?? root
  const said = typeof root.message === 'string' ? root.message : String(error)
  const failedQuery =
    typeof top.message === 'string'
      ? top.message.match(/^Failed query: ([\s\S]*?)(\nparams:|$)/)
      : null
  const statement = failedQuery?.[1]?.trim()
  const lines = [
    '✖ The migrations do not apply to an empty database — Postgres refused one:',
    `    ${said}${typeof root.code === 'string' ? ` (${root.code})` : ''}`,
  ]
  if (typeof root.detail === 'string') lines.push(`    detail: ${root.detail}`)
  if (typeof root.hint === 'string') lines.push(`    hint: ${root.hint}`)
  if (statement) {
    const short = statement.length > 400 ? `${statement.slice(0, 400)}…` : statement
    lines.push('  The statement:', `    ${short}`)
  }
  lines.push(
    added.length > 0
      ? `  New in this run: ${added.map(f => `migrations/${f}`).join(', ')} — written, applied nowhere.`
      : '  (Checked every migration; none was new in this run.)',
    '  Fix the SQL by hand before anyone runs `pnpm db:migrate` (.claude/rules/database.md — e.g.',
    '  drizzle-kit can put a composite FOREIGN KEY before the UNIQUE it needs: move it after),',
    '  then check again with `pnpm db:generate --check`.'
  )
  return lines
}
