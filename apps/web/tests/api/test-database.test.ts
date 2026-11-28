/**
 * The suite runs on this checkout's own database (`scripts/lib/test-db.mjs`): `vitest.config.ts`
 * pointed `DATABASE_URL` at it and `tests/setup.ts` created it, labelled with the checkout's path
 * for `pnpm test:db:prune`. A remote target (a Neon gate branch) is the database as given.
 */
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { rows } from '@/db/client'
import {
  checkoutComment,
  checkoutDatabaseName,
  checkoutPath,
  ENV_TEST_FILE,
  envTestDatabaseName,
} from '../../../../scripts/lib/test-db.mjs'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()
const remote = process.env.TEST_DATABASE_EPHEMERAL === '1'

describe('the test database', () => {
  it.skipIf(remote)("is this checkout's own, labelled with its path", async () => {
    const base = envTestDatabaseName(readFileSync(ENV_TEST_FILE, 'utf8')) as string
    const [row] = rows<{ name: string; comment: string | null }>(
      await db.execute(sql`
        SELECT current_database() AS name,
               shobj_description(d.oid, 'pg_database') AS comment
        FROM pg_database d WHERE d.datname = current_database()`)
    )
    expect(row?.name).toBe(checkoutDatabaseName(base, checkoutPath()))
    expect(row?.comment).toBe(checkoutComment(checkoutPath()))
  })
})
