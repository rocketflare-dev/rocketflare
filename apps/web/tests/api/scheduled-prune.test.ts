/**
 * Nightly prune (D12): expired sessions, expired/consumed magic links, expired invitations older
 * than 30 days are removed; live rows stay.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dispatchScheduled, runPruneExpired } from '@/api/scheduled'
import { hashToken } from '@/api/utils/core/hash'
import { randomToken } from '@/api/utils/core/ids'
import { magicLinkTokens, teamInvitations, userSessions } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, createTestUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

const db = setupTestDatabase()
const DAY = 86_400_000

describe('pruneExpired', () => {
  it('removes expired rows and keeps live ones', async () => {
    const user = await createTestUser(db)
    const expiredSession = await createTestSession(db, user.id, null, { expiresInDays: -1 })
    const liveSession = await createTestSession(db, user.id, null, { expiresInDays: 5 })

    const expiredLink = randomToken(32)
    const consumedLink = randomToken(32)
    const liveLink = randomToken(32)
    await db.insert(magicLinkTokens).values([
      {
        email: user.email,
        tokenHash: await hashToken(expiredLink),
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        email: user.email,
        tokenHash: await hashToken(consumedLink),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
      },
      {
        email: user.email,
        tokenHash: await hashToken(liveLink),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ])

    const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
    const oldExpired = randomToken(32)
    const recentExpired = randomToken(32)
    await db.insert(teamInvitations).values([
      {
        tenantId: tenant.id,
        email: 'old@example.test',
        role: 'member',
        tokenHash: await hashToken(oldExpired),
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() - 40 * DAY),
        revokedAt: new Date(),
      },
      {
        tenantId: tenant.id,
        email: 'recent@example.test',
        role: 'member',
        tokenHash: await hashToken(recentExpired),
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() - 2 * DAY),
      },
    ])

    const counts = await runPruneExpired(db)
    expect(counts.sessions).toBeGreaterThanOrEqual(1)
    expect(counts.magicLinks).toBeGreaterThanOrEqual(2)
    expect(counts.invitations).toBeGreaterThanOrEqual(1)

    expect(
      await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.tokenHash, await hashToken(expiredSession)))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.tokenHash, await hashToken(liveSession)))
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.tokenHash, await hashToken(expiredLink)))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.tokenHash, await hashToken(consumedLink)))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.tokenHash, await hashToken(liveLink)))
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(teamInvitations)
        .where(eq(teamInvitations.tokenHash, await hashToken(oldExpired)))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(teamInvitations)
        .where(eq(teamInvitations.tokenHash, await hashToken(recentExpired)))
    ).toHaveLength(1)
  })

  it('runs from the cron dispatcher', async () => {
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('0 4 * * *', createTestEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(reports).toEqual([expect.objectContaining({ task: 'pruneExpired', status: 'ok' })])
  })
})
