/**
 * Fact-table refresh + freshness (D19) against real Postgres: rows are built from seeded activity,
 * per-tenant DELETE+INSERT leaves other tenants alone, refresh is idempotent, the grain handles
 * NULL user ids, and freshness flags stale vs fresh.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  checkFactTableFreshness,
  computeFreshness,
  FACT_TABLES,
  factTableColumnNames,
  refreshAllFactTables,
  refreshFactTable,
} from '@/api/services/fact-tables'
import { activityEvents, tenantActivityDailyFacts } from '@/db/schema'
import { createTestTenantWithUser, createTestUser } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'

const db = setupTestDatabase()
const TABLE = 'tenant_activity_daily_facts'
const DAY = 24 * 60 * 60 * 1000

async function factRows(tenantId: string) {
  return db
    .select()
    .from(tenantActivityDailyFacts)
    .where(eq(tenantActivityDailyFacts.tenantId, tenantId))
    .orderBy(tenantActivityDailyFacts.day, tenantActivityDailyFacts.userId)
}

describe('refreshFactTable', () => {
  it('builds one row per (day, user) from activity_events, NULL actor included', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const other = await createTestUser(db)
    const today = new Date(Date.UTC(2026, 0, 10, 12))
    const yesterday = new Date(today.getTime() - DAY)
    await db.insert(activityEvents).values([
      { tenantId: tenant.id, userId: user.id, type: 'a.one', createdAt: today },
      { tenantId: tenant.id, userId: user.id, type: 'a.two', createdAt: today },
      { tenantId: tenant.id, userId: user.id, type: 'a.two', createdAt: yesterday },
      { tenantId: tenant.id, userId: other.id, type: 'b.one', createdAt: today },
      { tenantId: tenant.id, userId: null, type: 'cron.ran', createdAt: today },
      { tenantId: tenant.id, userId: null, type: 'cron.ran', createdAt: today },
    ])

    const result = await refreshFactTable(db, TABLE, { tenantId: tenant.id })
    expect(result).toMatchObject({ table: TABLE, tenants: 1, rows: 4, errors: [] })

    const rows = await factRows(tenant.id)
    expect(rows).toHaveLength(4)
    const byKey = new Map(rows.map(r => [`${r.day.toISOString().slice(0, 10)}:${r.userId}`, r]))
    expect(byKey.get(`2026-01-10:${user.id}`)).toMatchObject({
      eventCount: 2,
      distinctEventTypes: 2,
    })
    expect(byKey.get(`2026-01-09:${user.id}`)).toMatchObject({ eventCount: 1 })
    expect(byKey.get(`2026-01-10:${other.id}`)).toMatchObject({ eventCount: 1 })
    expect(byKey.get('2026-01-10:null')).toMatchObject({ eventCount: 2, distinctEventTypes: 1 })
    for (const r of rows) {
      expect(r.firstEventAt.getTime()).toBeLessThanOrEqual(r.lastEventAt.getTime())
      expect(r.factRefreshedAt).toBeInstanceOf(Date)
    }
  })

  it('is idempotent and only replaces the refreshed tenant’s rows', async () => {
    const a = await createTestTenantWithUser(db, 'owner')
    const b = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values([
      { tenantId: a.tenant.id, userId: a.user.id, type: 'x' },
      { tenantId: b.tenant.id, userId: b.user.id, type: 'x' },
      { tenantId: b.tenant.id, userId: b.user.id, type: 'y' },
    ])
    await refreshFactTable(db, TABLE, { tenantId: a.tenant.id })
    await refreshFactTable(db, TABLE, { tenantId: b.tenant.id })
    const [bBefore] = await factRows(b.tenant.id)
    expect(bBefore?.eventCount).toBe(2)

    // More activity for A, then refresh A only: B's rows are byte-for-byte untouched.
    await db.insert(activityEvents).values({ tenantId: a.tenant.id, userId: a.user.id, type: 'z' })
    const second = await refreshFactTable(db, TABLE, { tenantId: a.tenant.id })
    expect(second.rows).toBe(1)
    const [aRow] = await factRows(a.tenant.id)
    expect(aRow?.eventCount).toBe(2)
    expect(await factRows(a.tenant.id)).toHaveLength(1)
    const [bAfter] = await factRows(b.tenant.id)
    expect(bAfter).toEqual(bBefore)
  })

  it('names the INSERT columns from the schema mirror, in declaration order', () => {
    const def = FACT_TABLES.find(t => t.name === TABLE)
    if (!def) throw new Error('registry entry missing')
    expect(factTableColumnNames(def)).toEqual([
      'tenant_id',
      'day',
      'user_id',
      'event_count',
      'distinct_event_types',
      'first_event_at',
      'last_event_at',
      'fact_refreshed_at',
    ])
  })

  it('refreshAllFactTables walks every registry entry over every tenant', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values({ tenantId: tenant.id, userId: user.id, type: 'q' })
    const summary = await refreshAllFactTables(db)
    expect(summary.results.map(r => r.table)).toEqual(FACT_TABLES.map(t => t.name))
    expect(summary.results[0]?.tenants).toBeGreaterThanOrEqual(1)
    // NOT `summary.failed === 0`: this walks EVERY tenant in a database other test files write to
    // and delete from concurrently, so a per-tenant failure elsewhere is expected — isolating it
    // per tenant is the service's design.
    //
    // Our OWN tenant can lose that race too, which is what used to make this file flake (~1 run in
    // 20): `scheduled-facts.test.ts` dispatches the `15 * * * *` cron, which is a second full walk,
    // and two concurrent rebuilds of one tenant collide — the later DELETE runs on a snapshot taken
    // before the earlier INSERT committed, so it leaves those rows behind and its own INSERT hits
    // the grain unique index. That hazard is real in production as well (the cron overlapping a
    // manual `db:refresh-facts`) and is recorded in `services/fact-tables/CLAUDE.md`; it is not what
    // THIS test is about, so if we lost the race, rebuild our tenant alone and then assert.
    if (summary.results[0]?.errors.some(e => e.tenantId === tenant.id)) {
      await refreshFactTable(db, TABLE, { tenantId: tenant.id })
    }
    const rows = await db
      .select()
      .from(tenantActivityDailyFacts)
      .where(
        and(
          eq(tenantActivityDailyFacts.tenantId, tenant.id),
          eq(tenantActivityDailyFacts.userId, user.id)
        )
      )
    expect(rows).toHaveLength(1)
  })

  it('rejects an unknown table name', async () => {
    await expect(refreshFactTable(db, 'nope_facts')).rejects.toThrow(/Unknown fact table/)
  })
})

describe('freshness', () => {
  const def = { name: TABLE, refreshIntervalMinutes: 60 }
  const t0 = new Date('2026-03-01T12:00:00Z')
  const minutes = (n: number) => new Date(t0.getTime() + n * 60_000)

  it('fresh when the fact table is newer than the newest source row', () => {
    expect(computeFreshness(def, minutes(-5), minutes(-30), t0)).toEqual({
      table: TABLE,
      refreshedAt: minutes(-5),
      lagSeconds: 0,
      stale: false,
    })
  })

  it('fresh when new source rows have waited less than 2× the interval', () => {
    const s = computeFreshness(def, minutes(-90), minutes(-10), t0)
    expect(s.lagSeconds).toBe(80 * 60)
    expect(s.stale).toBe(false)
  })

  it('stale once the newest source row has waited more than 2× the interval', () => {
    const s = computeFreshness(def, minutes(-200), minutes(-10), t0)
    expect(s.lagSeconds).toBe(190 * 60)
    expect(s.stale).toBe(true)
  })

  it('never built: measured from the newest source row to now; empty source is fresh', () => {
    expect(computeFreshness(def, null, minutes(-30), t0)).toMatchObject({
      refreshedAt: null,
      lagSeconds: 30 * 60,
      stale: false,
    })
    expect(computeFreshness(def, null, minutes(-300), t0).stale).toBe(true)
    expect(computeFreshness(def, null, null, t0)).toMatchObject({ lagSeconds: 0, stale: false })
  })

  it('checkFactTableFreshness reports every registry entry from the live tables', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values({ tenantId: tenant.id, userId: user.id, type: 'f' })
    await refreshFactTable(db, TABLE, { tenantId: tenant.id })
    const statuses = await checkFactTableFreshness(db)
    expect(statuses.map(s => s.table)).toEqual(FACT_TABLES.map(t => t.name))
    const s = statuses[0]
    expect(s?.refreshedAt).toBeInstanceOf(Date)
    expect(typeof s?.lagSeconds).toBe('number')
    expect(typeof s?.stale).toBe('boolean')
  })
})
