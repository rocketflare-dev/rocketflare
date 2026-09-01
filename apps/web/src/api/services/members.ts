/**
 * Membership administration (D10): list, role change, removal — with the ownership invariants
 * the matrix leaves to routes: assigning or taking away `owner` is owner-only, the last owner can
 * never be demoted or removed, and `support` rows are managed only from /admin.
 */
import type { PaginationQuery } from '@rocketflare/shared/pagination'
import type { Member, TenantRole } from '@rocketflare/shared/tenants'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { tenantUserSettings, tenantUsers, userSessions, users } from '../../db/schema'
import { isOwnerLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/core/errors'
import { asCount, pageWindow } from '../utils/routes/pagination'
import { recordActivity } from './activity'
import { nudge, type Realtime, realtimeEvent } from './realtime'

export async function listMembers(db: Database, tenantId: string, query: PaginationQuery) {
  const { limit, offset } = pageWindow(query)
  const [rows, [count]] = await Promise.all([
    db
      .select({
        userId: tenantUsers.userId,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: tenantUsers.role,
        joinedAt: tenantUsers.joinedAt,
        lastLoginAt: users.lastLoginAt,
        invitedByUserId: tenantUsers.invitedByUserId,
      })
      .from(tenantUsers)
      .innerJoin(users, eq(users.id, tenantUsers.userId))
      .where(eq(tenantUsers.tenantId, tenantId))
      .orderBy(asc(tenantUsers.joinedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId)),
  ])
  return { items: rows satisfies Member[], total: asCount(count?.count) }
}

export async function countOwners(db: Database, tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql`count(*)` })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.role, 'owner')))
  return asCount(row?.count)
}

async function getMembership(db: Database, tenantId: string, userId: string) {
  const row = await db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
  if (!row) throw new NotFoundError('Member not found')
  return row
}

export async function changeMemberRole(
  db: Database,
  input: {
    tenantId: string
    targetUserId: string
    role: TenantRole
    actor: AuthContext
    realtime?: Realtime
  }
) {
  const target = await getMembership(db, input.tenantId, input.targetUserId)
  if (target.role === 'support') {
    throw new ForbiddenError(
      'Support access is managed from the admin console',
      'support_role_locked'
    )
  }
  const touchesOwner = target.role === 'owner' || input.role === 'owner'
  if (touchesOwner && !isOwnerLevel(input.actor)) {
    throw new ForbiddenError('Only an owner can assign or remove the owner role')
  }
  if (target.role === 'owner' && input.role !== 'owner') {
    if ((await countOwners(db, input.tenantId)) <= 1) {
      throw new ConflictError('An organisation must keep at least one owner', 'last_owner')
    }
  }
  if (target.role === input.role) return target
  const [updated] = await db
    .update(tenantUsers)
    .set({ role: input.role })
    .where(
      and(eq(tenantUsers.tenantId, input.tenantId), eq(tenantUsers.userId, input.targetUserId))
    )
    .returning()
  await recordActivity(db, {
    tenantId: input.tenantId,
    userId: input.actor.user.id,
    type: 'member.role_changed',
    subjectType: 'TenantMember',
    subjectId: input.targetUserId,
    metadata: { from: target.role, to: input.role },
  })
  nudge(input.realtime, realtimeEvent('member.changed', input.tenantId, { id: input.targetUserId }))
  return updated ?? target
}

export async function removeMember(
  db: Database,
  input: { tenantId: string; targetUserId: string; actor: AuthContext; realtime?: Realtime }
) {
  const target = await getMembership(db, input.tenantId, input.targetUserId)
  if (target.role === 'support') {
    throw new ForbiddenError(
      'Support access is managed from the admin console',
      'support_role_locked'
    )
  }
  if (target.role === 'owner') {
    if (!isOwnerLevel(input.actor)) throw new ForbiddenError('Only an owner can remove an owner')
    if ((await countOwners(db, input.tenantId)) <= 1) {
      throw new ConflictError('An organisation must keep at least one owner', 'last_owner')
    }
  }
  await db.transaction(async tx => {
    await tx
      .delete(tenantUsers)
      .where(
        and(eq(tenantUsers.tenantId, input.tenantId), eq(tenantUsers.userId, input.targetUserId))
      )
    await tx
      .delete(tenantUserSettings)
      .where(
        and(
          eq(tenantUserSettings.tenantId, input.tenantId),
          eq(tenantUserSettings.userId, input.targetUserId)
        )
      )
    // Sessions pinned to this tenant fall back to another membership on the next request.
    await tx
      .update(userSessions)
      .set({ selectedTenantId: null })
      .where(
        and(
          eq(userSessions.userId, input.targetUserId),
          eq(userSessions.selectedTenantId, input.tenantId)
        )
      )
  })
  await recordActivity(db, {
    tenantId: input.tenantId,
    userId: input.actor.user.id,
    type: 'member.removed',
    subjectType: 'TenantMember',
    subjectId: input.targetUserId,
    metadata: { role: target.role, self: input.actor.user.id === input.targetUserId },
  })
  nudge(input.realtime, realtimeEvent('member.changed', input.tenantId, { id: input.targetUserId }))
}
