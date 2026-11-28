/**
 * `pnpm db:generate`'s scratch check, the pure half (`scripts/lib/migration-check.ts`): which files
 * a run added, that it only ever runs on a local Postgres, the scratch database's name, and the
 * plain-words report of the migration Postgres refused — drizzle-kit once wrote a composite
 * FOREIGN KEY before the UNIQUE it needed, and the failure surfaced only when it was applied —
 * and the static order check for a generated column read before its input column is added.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeMigrationFailure,
  generatedColumnOrderIssues,
  newMigrationFiles,
  scratchCheckRefusal,
  scratchDatabaseName,
  withDatabase,
} from '../../scripts/lib/migration-check'

describe('migration-check', () => {
  it('newMigrationFiles lists only the NNNN_*.sql files a run added', () => {
    expect(
      newMigrationFiles(['0000_a.sql'], ['0000_a.sql', '0002_c.sql', '0001_b.sql', 'notes.sql'])
    ).toEqual(['0001_b.sql', '0002_c.sql'])
    expect(newMigrationFiles(['0000_a.sql'], ['0000_a.sql'])).toEqual([])
  })

  it('runs on a local Postgres only', () => {
    expect(scratchCheckRefusal('postgresql://u:p@localhost:5432/app_dev')).toBeNull()
    expect(scratchCheckRefusal('postgresql://u:p@127.0.0.1:5437/app_dev')).toBeNull()
    expect(scratchCheckRefusal(undefined)).toMatch(/not set/)
    expect(scratchCheckRefusal('postgresql://u:p@ep-x-pooler.eu.aws.neon.tech/db')).toMatch(
      /not a local Postgres/
    )
  })

  it('names a scratch database beside the dev one, within 63 bytes, and swaps it into the URL', () => {
    const name = scratchDatabaseName('postgresql://u:p@localhost/app_dev', 'AB12cd')
    expect(name).toBe('app_dev_gencheck_ab12cd')
    expect(scratchDatabaseName(`postgresql://u:p@localhost/${'x'.repeat(80)}`, 'ab').length).toBe(
      63
    )
    expect(withDatabase('postgresql://u:p@localhost:5432/app_dev?sslmode=disable', name)).toBe(
      `postgresql://u:p@localhost:5432/${name}?sslmode=disable`
    )
  })

  it("reports Postgres's own words, the statement and the new file, and what to do", () => {
    const pg = Object.assign(
      new Error('there is no unique constraint matching given keys for referenced table "a"'),
      { code: '42830' }
    )
    const wrapped = new Error(
      'Failed query: ALTER TABLE "b" ADD CONSTRAINT "b_fk" FOREIGN KEY ("tenant_id","a_id") REFERENCES "a"("tenant_id","id")\nparams: ',
      { cause: pg }
    )
    const text = describeMigrationFailure(wrapped, ['0038_bills.sql']).join('\n')
    expect(text).toContain('there is no unique constraint matching given keys')
    expect(text).toContain('(42830)')
    expect(text).toContain('ALTER TABLE "b" ADD CONSTRAINT "b_fk"')
    expect(text).not.toContain('params:')
    expect(text).toContain('migrations/0038_bills.sql')
    expect(text).toContain('pnpm db:generate --check')
  })

  it('says what a 42703 usually is: a column used before the statement that adds it', () => {
    const pg = Object.assign(new Error('column "context" does not exist'), { code: '42703' })
    const text = describeMigrationFailure(pg, ['0040_x.sql']).join('\n')
    expect(text).toMatch(/ADD COLUMN/)
    expect(text).toMatch(/before/)
  })
})

describe('generatedColumnOrderIssues', () => {
  // drizzle-kit's shape when one generate run carries a generated column's new input and other
  // changes: the regeneration lands before the ADD COLUMN it reads.
  const misordered = [
    'ALTER TABLE "chunks" DROP COLUMN "search_vector";',
    `ALTER TABLE "chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(context, '') || ' ' || content)) STORED;`,
    'ALTER TABLE "chunks" ADD COLUMN "context" text;',
    'ALTER TABLE "chunks" ADD COLUMN "context_model" text;',
  ].join('\n--> statement-breakpoint\n')

  it('names a generated column whose expression reads a column added later', () => {
    expect(generatedColumnOrderIssues(misordered)).toEqual([
      { table: 'chunks', generated: 'search_vector', column: 'context', usedAt: 2, addedAt: 3 },
    ])
  })

  it('passes the same statements in the right order, and an unrelated table', () => {
    const ordered = [
      'ALTER TABLE "chunks" ADD COLUMN "context" text;',
      'ALTER TABLE "chunks" ADD COLUMN "context_model" text;',
      'ALTER TABLE "chunks" DROP COLUMN "search_vector";',
      `ALTER TABLE "chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(context, '') || ' ' || content)) STORED;`,
      // `context` on another table is another column.
      'ALTER TABLE "notes" ADD COLUMN "context" text;',
    ].join('\n--> statement-breakpoint\n')
    expect(generatedColumnOrderIssues(ordered)).toEqual([])
    // Every migration this checkout ships applies, so none reads a column before adding it.
    const dir = path.resolve(import.meta.dirname, '../../migrations')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
      expect(generatedColumnOrderIssues(readFileSync(path.join(dir, file), 'utf8'))).toEqual([])
    }
    // A word inside a string literal is not a column reference.
    expect(
      generatedColumnOrderIssues(
        [
          `ALTER TABLE "t" ADD COLUMN "g" text GENERATED ALWAYS AS ('context' || "a") STORED;`,
          'ALTER TABLE "t" ADD COLUMN "context" text;',
        ].join('\n--> statement-breakpoint\n')
      )
    ).toEqual([])
  })
})
