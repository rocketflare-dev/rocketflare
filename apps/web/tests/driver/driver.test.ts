/**
 * The `driver` project (D35): the code that differs between `postgres` and `neon`, run against a
 * real database under whichever driver `.env.test` (or the environment) selects. The gate runs it
 * under `postgres`; `pnpm test:neon` and CI's `test-neon` job run it under `neon` through the local
 * proxy — so both halves run on every PR.
 *
 * Everything here goes through `openDatabase`, the Worker's own path (neon-http for queries, the
 * WebSocket pool for transactions), NOT the pool-only handle scripts and fixtures get.
 */
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveSession } from '@/api/auth/sessions'
import {
  affected,
  type DatabaseEnv,
  type DatabaseHandle,
  databaseDriver,
  openDatabase,
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
    expect(['neon', 'postgres']).toContain(driver)
    if (driver === 'neon') expect(env.NEON_LOCAL_PROXY).toMatch(/^https?:\/\//)
  })

  it('rows() reads a raw result: types parse the same way under both drivers', async () => {
    const { db } = open()
    const [row] = rows<{
      n: number
      big: string
      j: { a: number }
      arr: string[]
      raw_arr: unknown
      v: string
      ts: string | Date
      nothing: null
    }>(
      await db.execute(sql`
        SELECT 1::int AS n, 9007199254740993::bigint AS big, '{"a":1}'::jsonb AS j,
               to_jsonb(ARRAY['x','y']) AS arr, ARRAY['x','y']::text[] AS raw_arr,
               '[1,2,3]'::vector AS v, now() AS ts, NULL AS nothing`)
    )
    expect(row).toBeDefined()
    expect(row?.n).toBe(1)
    // bigint stays a string on both — never silently rounded through a JS number.
    expect(String(row?.big)).toBe('9007199254740993')
    expect(row?.j).toEqual({ a: 1 })
    expect(row?.arr).toEqual(['x', 'y'])
    // THE trap: a raw Postgres array is parsed by Neon but NOT by postgres.js (`fetch_types: false`
    // skips the array-type lookup, so it arrives as the literal "{x,y}"). Raw SQL returning a list
    // goes through json (`json_agg`, `to_jsonb`) — `traces.ts` does. rules/database.md says so.
    expect(row?.raw_arr).toEqual(driver === 'neon' ? ['x', 'y'] : '{x,y}')
    expect(row?.v).toBe('[1,2,3]')
    // Timestamps: a Date (postgres.js) or an ISO-ish string (neon-http). Code reading a raw
    // timestamp must accept both, which is why sessions.ts and traces.ts wrap them in `asDate`.
    expect(Number.isNaN(new Date(row?.ts as string).getTime())).toBe(false)
    expect(row?.nothing).toBeNull()
    expect(rows(await db.execute(sql`SELECT 1 WHERE false`))).toEqual([])
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
