/**
 * Upgrading a 0.36.1 database through `0027_kit-knowledge-chunk-structure`: the dense leg now
 * filters on `chunks.embedding_model`, so the migration must BACKFILL it from the document — an
 * upgrade that skipped it would leave every tenant's dense search returning nothing. And the
 * generated `search_vector` must be populated for rows that existed before the column did.
 *
 * The migrator cannot stop at a given migration, so the test gives it a cut-down copy of the
 * folder (the SQL files and a journal truncated at 0026) on a uniquely named scratch database on
 * the test server, writes a document and a chunk the 0.36.1 way, then runs the REAL folder over it
 * and reads the row back. The scratch database is dropped afterwards; the shared test database is
 * never touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../../scripts/migrate'
import { testDatabaseUrl } from '../helpers/db'
import { isEphemeralTestRun } from '../helpers/db-safety'

/**
 * Skipped on a remote target (`pnpm test` on a Neon gate branch): it needs TCP to the server and
 * the right to CREATE DATABASE, which a gate branch's role and a 443-only sandbox do not give.
 */
const EPHEMERAL = isEphemeralTestRun(process.env)
const SKIPPED = EPHEMERAL ? ' [skipped: ephemeral gate — no TCP, no CREATE DATABASE]' : ''

const MIGRATIONS = path.resolve(import.meta.dirname, '../../migrations')
const LAST_BEFORE = '0026_kit-tenant-creation-counters'
const scratchName = `rf_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const env = { ...process.env, DATABASE_DRIVER: 'postgres', NEON_LOCAL_PROXY: '' }

function scratchUrl(): string {
  const url = new URL(testDatabaseUrl())
  url.pathname = `/${scratchName}`
  return url.toString()
}

/** The migrations folder as 0.36.1 shipped it: every file up to and including 0026. */
function folderUpTo(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-migrations-'))
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')
  ) as { entries: { idx: number; tag: string }[] }
  const cut = journal.entries.findIndex(e => e.tag === tag)
  if (cut < 0) throw new Error(`no migration ${tag}`)
  const entries = journal.entries.slice(0, cut + 1)
  fs.mkdirSync(path.join(dir, 'meta'))
  fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) {
    fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`))
  }
  return dir
}

const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
let created = false
let folder: string | null = null

describe.skipIf(EPHEMERAL)(`migration 0027 on a 0.36.1 database${SKIPPED}`, () => {
  afterAll(async () => {
    if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
    await admin.end({ timeout: 5 })
    if (folder) fs.rmSync(folder, { recursive: true, force: true })
  })

  it('backfills chunks.embedding_model from the document and fills search_vector', async () => {
    await admin.unsafe(`CREATE DATABASE ${scratchName}`)
    created = true
    folder = folderUpTo(LAST_BEFORE)
    await runMigrations(scratchUrl(), { migrationsFolder: folder, quiet: true, env })

    const scratch = postgres(scratchUrl(), { max: 1, onnotice: () => {} })
    try {
      // The 0.36.1 shape: no embedding_model, offsets or search_vector on chunks yet.
      const before = await scratch<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name IN ('embedding_model', 'search_vector')`
      expect(before).toEqual([])
      const [tenant] = await scratch<{ id: string }[]>`
        INSERT INTO tenants (name, slug) VALUES ('Upgrade Co', ${scratchName}) RETURNING id`
      const [doc] = await scratch<{ id: string }[]>`
        INSERT INTO documents (tenant_id, title, content, status, chunk_count, embedding_model)
        VALUES (${tenant?.id as string}, 'Handbook', 'Pedestrians walk on segregated paths.',
                'indexed', 1, '@cf/baai/bge-m3')
        RETURNING id`
      const vector = `[${Array.from({ length: 1024 }, () => 0.01).join(',')}]`
      await scratch`
        INSERT INTO chunks (document_id, tenant_id, seq, text, token_count, embedding)
        VALUES (${doc?.id as string}, ${tenant?.id as string}, 0,
                'Pedestrians walk on segregated paths.', 10, ${vector}::vector)`

      await runMigrations(scratchUrl(), { migrationsFolder: MIGRATIONS, quiet: true, env })

      const [chunk] = await scratch<
        { embedding_model: string | null; has_vector: boolean; matches: boolean }[]
      >`
        SELECT embedding_model,
               search_vector IS NOT NULL AS has_vector,
               search_vector @@ to_tsquery('english', 'pedestrian & segregate') AS matches
        FROM chunks WHERE document_id = ${doc?.id as string}`
      expect(chunk).toEqual({ embedding_model: '@cf/baai/bge-m3', has_vector: true, matches: true })
    } finally {
      await scratch.end({ timeout: 5 })
    }
  })
})
