/**
 * The `"15 * * * *"` cron (D19) rebuilds the fact tables through the plain dispatcher.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dispatchScheduled, SCHEDULED_TASKS } from '@/api/scheduled'
import { activityEvents, tenantActivityDailyFacts } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

const db = setupTestDatabase()

describe('scheduled: fact-table refresh', () => {
  it('registers refreshFactTables on the hourly :15 cron', () => {
    expect(SCHEDULED_TASKS['15 * * * *']?.map(t => t.name)).toEqual(['refreshFactTables'])
  })

  it('dispatching the cron rebuilds the fact table for seeded activity', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    await db.insert(activityEvents).values([
      { tenantId: tenant.id, userId: user.id, type: 'cron.a' },
      { tenantId: tenant.id, userId: user.id, type: 'cron.b' },
    ])
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('15 * * * *', createTestEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([
      expect.objectContaining({ cron: '15 * * * *', task: 'refreshFactTables', status: 'ok' }),
    ])
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
    expect(rows[0]?.eventCount).toBe(2)
    expect(rows[0]?.distinctEventTypes).toBe(2)
  })
})
