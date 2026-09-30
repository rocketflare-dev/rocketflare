/**
 * The CONFORMANCE suite for the driver seam (D35, tests/driver/CLAUDE.md): every test states one
 * equivalence between `postgres` and `neon` and passes UNCHANGED under both. `pnpm test` runs this
 * project twice on a local target — under `postgres`, then under `neon` through the local proxy —
 * and once, under `neon`, on a real Neon gate branch. A test that fails under one driver is a hole
 * in `src/db/client.ts` or the guard (`tests/config/driver-results.test.ts`): fix it THERE, never
 * by skipping or weakening the test (`tests/config/driver-conformance.test.ts` fails a skip or a
 * per-driver expectation).
 *
 * Everything here goes through `openDatabase`, the Worker's own path (neon-http for queries, the
 * WebSocket pool for transactions), NOT the pool-only handle scripts and fixtures get.
 */
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveSession } from '@/api/auth/sessions'
import {
  affected,
  DATABASE_DRIVERS,
  type DatabaseEnv,
  type DatabaseHandle,
  databaseDriver,
  isUniqueViolation,
  openDatabase,
  pgErrorCode,
  rows,
} from '@/db/client'
import { aiSpans, featureFlags } from '@/db/schema'
import { withTenantScope } from '@/db/tenant-scope'
import { runMigrations } from '../../scripts/migrate'
import { createTestSession, createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'

const env: DatabaseEnv = {
  DATABASE_DRIVER: process.env.DATABASE_DRIVER,
  NEON_LOCAL_PROXY: process.env.NEON_LOCAL_PROXY,
  DATABASE_URL: testDatabaseUrl(),
}
const driver = databaseDriver(env)
const fixtures = setupTestDatabase()

const handles: DatabaseHandle[] = []
function open(): DatabaseHandle {
  const handle = openDatabase(env)
  handles.push(handle)
  return handle
}
afterAll(async () => {
  await Promise.all(handles.map(h => h.close()))
})

describe(`database driver: ${driver}`, () => {
  it('runs under the driver the environment selects', () => {
    expect(DATABASE_DRIVERS).toContain(driver)
  })

  // One probe, read over HTTP (a plain query) and over the WebSocket pool (inside a transaction),
  // because under `neon` those are two different clients with their own type handling.
  const PROBE = sql`
    SELECT 1::int AS n, 9007199254740993::bigint AS big, 1.5::numeric AS num, 1.5::float8 AS f,
           true AS b, '{"a":1}'::jsonb AS j, to_jsonb(ARRAY['x','y']) AS json_arr,
           ARRAY['x','y']::text[] AS text_arr, ARRAY[1,2]::int[] AS int_arr,
           ARRAY[3]::bigint[] AS big_arr, ARRAY[true,false] AS bool_arr,
           ARRAY['00000000-0000-4000-8000-000000000001'::uuid] AS uuid_arr,
           ARRAY['{"a":1}'::jsonb] AS jsonb_arr,
           '[1,2,3]'::vector AS v, '2026-01-02 03:04:05.678+00'::timestamptz AS tstz,
           '2026-01-02 03:04:05.678'::timestamp AS ts, '2026-01-02'::date AS d,
           ARRAY['2026-01-02 03:04:05+00'::timestamptz] AS tstz_arr, '1 day'::interval AS iv,
           NULL AS nothing`
  const EXPECTED = {
    n: 1,
    // bigint and numeric stay strings — never silently rounded through a JS number.
    big: '9007199254740993',
    num: '1.5',
    f: 1.5,
    b: true,
    j: { a: 1 },
    json_arr: ['x', 'y'],
    // Raw arrays parse to arrays under both (client.ts `ARRAY_PARSERS`).
    text_arr: ['x', 'y'],
    int_arr: [1, 2],
    big_arr: ['3'],
    bool_arr: [true, false],
    uuid_arr: ['00000000-0000-4000-8000-000000000001'],
    jsonb_arr: [{ a: 1 }],
    v: '[1,2,3]',
    // Raw date/time values are Postgres's text under both (drizzle keeps them unparsed so its
    // column mappers can): code reading one from raw SQL parses it itself.
    tstz: '2026-01-02 03:04:05.678+00',
    ts: '2026-01-02 03:04:05.678',
    d: '2026-01-02',
    tstz_arr: '{"2026-01-02 03:04:05+00"}',
    iv: '1 day',
    nothing: null,
  }

  it('rows() reads a raw result: every type parses the same way under both drivers', async () => {
    const { db } = open()
    expect(rows(await db.execute(PROBE))[0]).toEqual(EXPECTED)
    expect(rows(await db.execute(sql`SELECT 1 WHERE false`))).toEqual([])
  })

  it('… and the same inside a transaction', async () => {
    const { db } = open()
    const inside = await db.transaction(async tx => rows(await tx.execute(PROBE))[0])
    expect(inside).toEqual(EXPECTED)
  })

  it('a unique violation reads as one (pgErrorCode / isUniqueViolation), in and out of a transaction', async () => {
    const { db } = open()
    // Raised by name, so no table is touched: the SQLSTATE is the thing under test.
    const violate = sql`DO $$ BEGIN RAISE unique_violation USING MESSAGE = 'driver probe'; END $$`
    const failure = (run: () => Promise<unknown>) =>
      run().then(
        () => null,
        (error: unknown) => error
      )
    const plain = await failure(() => db.execute(violate))
    const inTx = await failure(() => db.transaction(async tx => tx.execute(violate)))
    expect(pgErrorCode(plain)).toBe('23505')
    expect(isUniqueViolation(plain)).toBe(true)
    expect(pgErrorCode(inTx)).toBe('23505')
    expect(isUniqueViolation(inTx)).toBe(true)
    expect(isUniqueViolation(new Error('not a database error'))).toBe(false)
  })

  it('affected() counts an insert / delete without .returning()', async () => {
    const { db } = open()
    const { tenant } = await createTestTenantWithUser(fixtures)
    const span = (id: string) => ({
      tenantId: tenant.id,
      traceId: 'd'.repeat(32),
      spanId: id,
      name: 'driver probe',
      kind: 'llm' as const,
      status: 'ok' as const,
      startedAt: new Date(),
      endedAt: new Date(),
      durationMs: 0,
      attributes: {},
    })
    expect(
      affected(await db.insert(aiSpans).values([span('1'.repeat(16)), span('2'.repeat(16))]))
    ).toBe(2)
    expect(affected(await db.delete(aiSpans).where(eq(aiSpans.tenantId, tenant.id)))).toBe(2)
    expect(affected(await db.delete(aiSpans).where(eq(aiSpans.tenantId, tenant.id)))).toBe(0)
  })

  it('the query builder maps rows (timestamps as Date) the same under both', async () => {
    const { db } = open()
    const { tenant } = await createTestTenantWithUser(fixtures)
    const [first] = await db
      .select({ id: aiSpans.id })
      .from(aiSpans)
      .where(and(eq(aiSpans.tenantId, tenant.id)))
    expect(first).toBeUndefined()
    const [flag] = await db.select().from(featureFlags).limit(1)
    if (flag) expect(flag.updatedAt).toBeInstanceOf(Date)
  })

  it('transaction: set_config(…, true) and SET LOCAL hold inside, vanish after, roll back on throw', async () => {
    const { db } = open()
    const inside = await db.transaction(async tx => {
      await tx.execute(sql`select set_config('app.tenant_id', 'driver-probe', true)`)
      await tx.execute(sql`set local statement_timeout = 4321`)
      return rows<{ t: string; st: string }>(
        await tx.execute(
          sql`select current_setting('app.tenant_id') as t, current_setting('statement_timeout') as st`
        )
      )[0]
    })
    expect(inside).toEqual({ t: 'driver-probe', st: '4321ms' })

    const after = rows<{ t: string | null }>(
      await db.execute(sql`select nullif(current_setting('app.tenant_id', true), '') as t`)
    )[0]
    expect(after?.t ?? null).toBeNull()

    const { tenant } = await createTestTenantWithUser(fixtures)
    await expect(
      db.transaction(async tx => {
        await tx.insert(aiSpans).values({
          tenantId: tenant.id,
          traceId: 'e'.repeat(32),
          spanId: '3'.repeat(16),
          name: 'rolled back',
          kind: 'llm',
          status: 'ok',
          startedAt: new Date(),
          endedAt: new Date(),
          durationMs: 0,
          attributes: {},
        })
        throw new Error('roll back')
      })
    ).rejects.toThrow('roll back')
    const left = await db.select().from(aiSpans).where(eq(aiSpans.tenantId, tenant.id))
    expect(left).toEqual([])
  })

  it('withTenantScope enforce: the scoped handle sees app.tenant_id', async () => {
    const { db } = open()
    const { tenant } = await createTestTenantWithUser(fixtures)
    const seen = await withTenantScope(db, tenant.id, 'enforce', async scoped =>
      rows<{ t: string }>(await scoped.execute(sql`select current_setting('app.tenant_id') as t`))
    )
    expect(seen[0]?.t).toBe(tenant.id)
  })

  it('the session resolver (one raw query, every request) reads its row', async () => {
    const { db } = open()
    const { user, tenant } = await createTestTenantWithUser(fixtures)
    const token = await createTestSession(fixtures, user.id, tenant.id)
    const resolved = await resolveSession(db, token)
    expect(resolved?.user.id).toBe(user.id)
    expect(resolved?.user.createdAt).toBeInstanceOf(Date)
    expect(resolved?.session.expiresAt).toBeInstanceOf(Date)
    expect(resolved?.membership?.tenantId).toBe(tenant.id)
  })

  it('a handle that never queried closes cleanly, twice', async () => {
    const handle = openDatabase(env)
    await handle.close()
    await handle.close()
  })

  it('the migrator re-runs cleanly (already applied) over this driver', async () => {
    await runMigrations(testDatabaseUrl(), { quiet: true, maxAttempts: 5, env: process.env })
  })
})
