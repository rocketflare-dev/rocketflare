/**
 * Membership administration: list, role change, removal — with the ownership invariants
 * the matrix leaves to routes: assigning or taking away `owner` is owner-only, the last owner can
 * never be demoted or removed, `support` rows are managed only from /admin, and `idp` rows
 * (`source = 'idp'`, IdP-managed tenancy) are managed only by the OIDC issuer — 409 `idp_managed`
 * on both role change and removal.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { PaginationQuery } from '@rocketflare/shared/pagination'
import type { Member, TenantRole } from '@rocketflare/shared/tenants'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { tenantUserSettings, tenantUsers, userSessions, users } from '../../db/schema'
import { isOwnerLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/core/errors'
import { assertMayOwnAnother } from '../utils/db/tenant-helpers'
import { asCount, pageWindow } from '../utils/routes/pagination'
import { recordActivity } from './activity'
import { groupsForMembers } from './groups'
import { revokeInvitationsIssuedBy, rolesNotIssuableBy } from './invitations'
import { closeUserSockets, nudge, type Realtime, realtimeEvent } from './realtime'

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
        source: tenantUsers.source,
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
  // Group badges for the WHOLE page in one query — never the member list once per group, which
  // is N+1 in the number of groups.
  const groups = await groupsForMembers(
    db,
    tenantId,
    rows.map(r => r.userId)
  )
  const items: Member[] = rows.map(row => ({ ...row, groups: groups.get(row.userId) ?? [] }))
  return { items, total: asCount(count?.count) }
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

/** An `idp` membership follows the issuer's claims and events; the app may not change it. */
function assertNotIdpManaged(target: { source: string }) {
  if (target.source === 'idp') {
    throw new ConflictError(
      'This membership is managed by your identity provider. Change it there.',
      ERROR_CODES.idpManaged
    )
  }
}

export async function changeMemberRole(
  db: Database,
  input: {
    tenantId: string
    targetUserId: string
    role: TenantRole
    actor: AuthContext
    realtime?: Realtime
    /**
     * `MAX_OWNED_TENANTS_PER_USER`: a promotion to owner is refused (403 `tenant_limit_reached`)
     * for a target who already owns that many. Omitted, no ceiling.
     */
    maxOwnedTenants?: number
  }
) {
  const target = await getMembership(db, input.tenantId, input.targetUserId)
  if (target.role === 'support') {
    throw new ForbiddenError(
      'Support access is managed from the admin console',
      'support_role_locked'
    )
  }
  assertNotIdpManaged(target)
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
  const { updated, revokedInvitations } = await db.transaction(async tx => {
    if (input.role === 'owner' && input.maxOwnedTenants !== undefined) {
      await assertMayOwnAnother(
        tx as unknown as Database,
        input.targetUserId,
        input.maxOwnedTenants
      )
    }
    const [updated] = await tx
      .update(tenantUsers)
      .set({ role: input.role })
      .where(
        and(eq(tenantUsers.tenantId, input.tenantId), eq(tenantUsers.userId, input.targetUserId))
      )
      .returning()
    // The target's pending invitations last only as far as the new role could issue them.
    const revokedInvitations = await revokeInvitationsIssuedBy(tx as unknown as Database, {
      tenantId: input.tenantId,
      userId: input.targetUserId,
      roles: rolesNotIssuableBy(input.role),
    })
    return { updated, revokedInvitations }
  })
  await recordActivity(db, {
    tenantId: input.tenantId,
    userId: input.actor.user.id,
    type: 'member.role_changed',
    subjectType: 'TenantMember',
    subjectId: input.targetUserId,
    metadata: { from: target.role, to: input.role },
  })
  nudge(input.realtime, realtimeEvent('member.changed', input.tenantId, { id: input.targetUserId }))
  if (revokedInvitations.length > 0) {
    nudge(input.realtime, realtimeEvent('invitation.changed', input.tenantId))
  }
  return updated ?? target
}

/**
 * The global-admin role is gone, so every `support` row it minted goes with it, in the caller's
 * transaction: membership, the sessions pinned there and the activity line the tenant sees. Keys
 * minted under the row stop with it, because `validateApiKey` joins the membership.
 */
export async function endSupportMemberships(
  tx: Database,
  input: { userId: string; actorUserId: string }
): Promise<string[]> {
  const ended = await tx
    .delete(tenantUsers)
    .where(and(eq(tenantUsers.userId, input.userId), eq(tenantUsers.role, 'support')))
    .returning({ tenantId: tenantUsers.tenantId })
  if (ended.length === 0) return []
  const tenantIds = ended.map(row => row.tenantId)
  await tx
    .update(userSessions)
    .set({ selectedTenantId: null })
    .where(
      and(eq(userSessions.userId, input.userId), inArray(userSessions.selectedTenantId, tenantIds))
    )
  for (const tenantId of tenantIds) {
    await revokeInvitationsIssuedBy(tx, { tenantId, userId: input.userId })
    await recordActivity(tx, {
      tenantId,
      userId: input.actorUserId,
      type: 'support.left',
      subjectType: 'TenantMember',
      subjectId: input.userId,
    })
  }
  return tenantIds
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
  assertNotIdpManaged(target)
  if (target.role === 'owner') {
    if (!isOwnerLevel(input.actor)) throw new ForbiddenError('Only an owner can remove an owner')
    if ((await countOwners(db, input.tenantId)) <= 1) {
      throw new ConflictError('An organisation must keep at least one owner', 'last_owner')
    }
  }
  const revokedInvitations = await db.transaction(async tx => {
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
    return revokeInvitationsIssuedBy(tx as unknown as Database, {
      tenantId: input.tenantId,
      userId: input.targetUserId,
    })
  })
  closeUserSockets(input.realtime, input.tenantId, input.targetUserId)
  await recordActivity(db, {
    tenantId: input.tenantId,
    userId: input.actor.user.id,
    type: 'member.removed',
    subjectType: 'TenantMember',
    subjectId: input.targetUserId,
    metadata: { role: target.role, self: input.actor.user.id === input.targetUserId },
  })
  nudge(input.realtime, realtimeEvent('member.changed', input.tenantId, { id: input.targetUserId }))
  if (revokedInvitations.length > 0) {
    nudge(input.realtime, realtimeEvent('invitation.changed', input.tenantId))
  }
}
