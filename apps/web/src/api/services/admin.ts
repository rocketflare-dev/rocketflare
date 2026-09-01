/**
 * Global-admin operations (D9, D10, D25) — the ONLY cross-tenant service module, reached solely
 * through `globalAdminMiddleware`. Access-request decisions, tenant list/detail/suspend, support
 * enter/leave (a REAL `support` membership row, not a hidden bypass), users, global-admin flag
 * (the last one cannot be demoted), block (which deletes every session).
 */
import type {
  AccessRequest,
  AccessRequestListQuery,
  DecideAccessRequest,
} from '@rocketflare/shared/access-requests'
import type {
  AdminTenantDetail,
  AdminTenantListItem,
  AdminTenantListQuery,
  AdminUserDetail,
  AdminUserListItem,
  AdminUserListQuery,
} from '@rocketflare/shared/admin'
import { NON_MEMBER_ROLES } from '@rocketflare/shared/tenants'
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import {
  accessRequests,
  oauthProviders,
  tenants,
  tenantUsers,
  type User,
  userSessions,
  users,
} from '../../db/schema'
import { deleteUserSessions, updateSelectedTenant } from '../auth/sessions'
import { ConflictError, NotFoundError } from '../utils/core/errors'
import type { Logger } from '../utils/core/logger'
import { createTenantForUser } from '../utils/db/tenant-helpers'
import { asCount, pageWindow } from '../utils/routes/pagination'
import { recordActivity } from './activity'
import { nameFromEmail } from './auth'
import { accessRequestDecidedEmail } from './email'
import { enqueueJob, type JobsQueue } from './jobs'
import { notify } from './notifications'

type AdminLogger = Pick<Logger, 'info' | 'warn' | 'error'>

// ---- Access requests ------------------------------------------------------------------------

function toAccessRequest(
  row: typeof accessRequests.$inferSelect,
  requestedTenantName: string | null
): AccessRequest {
  return {
    id: row.id,
    email: row.email,
    userId: row.userId,
    requestedTenantId: row.requestedTenantId,
    requestedTenantName,
    message: row.message,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  }
}

export async function listAccessRequests(db: Database, query: AccessRequestListQuery) {
  const { limit, offset } = pageWindow(query)
  const where = and(
    query.status ? eq(accessRequests.status, query.status) : undefined,
    query.q ? ilike(accessRequests.email, `%${query.q}%`) : undefined
  )
  const [rows, [count]] = await Promise.all([
    db
      .select({ request: accessRequests, tenantName: tenants.name })
      .from(accessRequests)
      .leftJoin(tenants, eq(tenants.id, accessRequests.requestedTenantId))
      .where(where)
      .orderBy(sql`(${accessRequests.status} = 'pending') DESC`, asc(accessRequests.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(accessRequests).where(where),
  ])
  return {
    items: rows.map(r => toAccessRequest(r.request, r.tenantName)),
    total: asCount(count?.count),
  }
}

export async function decideAccessRequest(
  db: Database,
  cfg: AppConfig,
  logger: AdminLogger,
  jobs: JobsQueue,
  input: { id: string; decision: DecideAccessRequest; admin: User }
): Promise<AccessRequest> {
  const request = await db.query.accessRequests.findFirst({
    where: eq(accessRequests.id, input.id),
  })
  if (!request) throw new NotFoundError('Access request not found')
  if (request.status !== 'pending') {
    throw new ConflictError('This request has already been decided', 'access_request_decided')
  }

  let tenantName: string | undefined
  let tenantId: string | undefined
  let userId = request.userId

  if (input.decision.decision === 'approve') {
    // A request lodged from the login page may predate any user row.
    if (!userId) {
      const existing = await db.query.users.findFirst({
        where: sql`lower(${users.email}) = ${request.email.toLowerCase()}`,
      })
      if (existing) userId = existing.id
      else {
        const [created] = await db
          .insert(users)
          .values({ email: request.email.toLowerCase(), name: nameFromEmail(request.email) })
          .returning()
        if (!created) throw new Error('decideAccessRequest: user insert returned no row')
        userId = created.id
      }
    }
    const approve = input.decision.approve
    if (approve.mode === 'join') {
      const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, approve.tenantId) })
      if (!tenant) throw new NotFoundError('Organisation not found')
      await db
        .insert(tenantUsers)
        .values({
          tenantId: tenant.id,
          userId,
          role: approve.role,
          invitedByUserId: input.admin.id,
        })
        .onConflictDoNothing()
      tenantId = tenant.id
      tenantName = tenant.name
    } else {
      const tenant = await createTenantForUser(db, {
        name: approve.name,
        slug: approve.slug,
        userId,
        role: 'owner',
      })
      tenantId = tenant.id
      tenantName = tenant.name
    }
  }

  const [decided] = await db
    .update(accessRequests)
    .set({
      status: input.decision.decision === 'approve' ? 'approved' : 'rejected',
      userId,
      decidedByUserId: input.admin.id,
      decidedAt: new Date(),
    })
    .where(eq(accessRequests.id, request.id))
    .returning()
  if (!decided) throw new NotFoundError('Access request not found')

  if (tenantId && userId) {
    await recordActivity(db, {
      tenantId,
      userId: input.admin.id,
      type: 'member.joined',
      subjectType: 'TenantMember',
      subjectId: userId,
      metadata: { via: 'access_request', accessRequestId: request.id },
    })
    await notify(db, {
      tenantId,
      userId,
      type: 'access_request_decided',
      title: 'Your access request was approved',
      body: `You now have access to ${tenantName}.`,
      data: { accessRequestId: request.id },
    })
  }
  // The decision email is queued (D7): the row is already decided, delivery can lag and retry.
  const message = accessRequestDecidedEmail(cfg, request.email, {
    approved: input.decision.decision === 'approve',
    tenantName,
    reason: input.decision.decision === 'reject' ? input.decision.reason : undefined,
  })
  await enqueueJob(jobs, {
    type: 'email.send',
    payload: {
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      link: message.link,
      tenantId,
      reason: 'access_request_decided',
    },
  })
  logger.info({ accessRequestId: request.id, to: request.email }, 'access request decided')
  return toAccessRequest(decided, tenantName ?? null)
}

// ---- Tenants --------------------------------------------------------------------------------

const memberCountSql = sql<number>`(
  SELECT count(*)::int FROM tenant_users tu
  WHERE tu.tenant_id = ${tenants.id} AND tu.role NOT IN (${sql.join(
    NON_MEMBER_ROLES.map(r => sql`${r}`),
    sql`, `
  )})
)`

function toAdminTenant(row: typeof tenants.$inferSelect, memberCount: number): AdminTenantListItem {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    memberCount,
    seedDataCreated: row.seedDataCreated,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
  }
}

export async function listAdminTenants(db: Database, query: AdminTenantListQuery) {
  const { limit, offset } = pageWindow(query)
  const where = and(
    query.status ? eq(tenants.status, query.status) : undefined,
    query.q
      ? or(ilike(tenants.name, `%${query.q}%`), ilike(tenants.slug, `%${query.q}%`))
      : undefined
  )
  const [rows, [count]] = await Promise.all([
    db
      .select({ tenant: tenants, memberCount: memberCountSql })
      .from(tenants)
      .where(where)
      .orderBy(asc(tenants.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(tenants).where(where),
  ])
  return {
    items: rows.map(r => toAdminTenant(r.tenant, Number(r.memberCount))),
    total: asCount(count?.count),
  }
}

export async function getAdminTenant(
  db: Database,
  tenantId: string,
  adminUserId: string
): Promise<AdminTenantDetail> {
  const [row] = await db
    .select({ tenant: tenants, memberCount: memberCountSql })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!row) throw new NotFoundError('Organisation not found')
  const members = await db
    .select({
      userId: tenantUsers.userId,
      email: users.email,
      name: users.name,
      role: tenantUsers.role,
      isGlobalAdmin: users.isGlobalAdmin,
      blockedAt: users.blockedAt,
      joinedAt: tenantUsers.joinedAt,
    })
    .from(tenantUsers)
    .innerJoin(users, eq(users.id, tenantUsers.userId))
    .where(eq(tenantUsers.tenantId, tenantId))
    .orderBy(asc(tenantUsers.joinedAt))
  return {
    ...toAdminTenant(row.tenant, Number(row.memberCount)),
    members,
    supportAccess: members.some(m => m.userId === adminUserId && m.role === 'support'),
  }
}

export async function setTenantSuspended(
  db: Database,
  tenantId: string,
  suspended: boolean,
  admin: User
) {
  const [row] = await db
    .update(tenants)
    .set({ status: suspended ? 'suspended' : 'active' })
    .where(eq(tenants.id, tenantId))
    .returning()
  if (!row) throw new NotFoundError('Organisation not found')
  await recordActivity(db, {
    tenantId,
    userId: admin.id,
    type: suspended ? 'tenant.suspended' : 'tenant.reactivated',
    subjectType: 'Tenant',
    subjectId: tenantId,
  })
  return row
}

/** Mint (or keep) a `support` membership and point the admin's session at the tenant. */
export async function enterSupport(db: Database, tenantId: string, admin: User, sessionId: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) })
  if (!tenant) throw new NotFoundError('Organisation not found')
  const existing = await db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, admin.id)),
  })
  if (!existing) {
    await db.insert(tenantUsers).values({ tenantId, userId: admin.id, role: 'support' })
    await recordActivity(db, {
      tenantId,
      userId: admin.id,
      type: 'support.entered',
      subjectType: 'TenantMember',
      subjectId: admin.id,
    })
  }
  await updateSelectedTenant(db, sessionId, tenantId)
  return tenant
}

/** Remove the `support` row (a real membership is left alone) and unpin the session. */
export async function leaveSupport(db: Database, tenantId: string, admin: User, sessionId: string) {
  const removed = await db
    .delete(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        eq(tenantUsers.userId, admin.id),
        eq(tenantUsers.role, 'support')
      )
    )
    .returning({ userId: tenantUsers.userId })
  if (removed.length > 0) {
    await recordActivity(db, {
      tenantId,
      userId: admin.id,
      type: 'support.left',
      subjectType: 'TenantMember',
      subjectId: admin.id,
    })
  }
  await db
    .update(userSessions)
    .set({ selectedTenantId: null })
    .where(and(eq(userSessions.id, sessionId), eq(userSessions.selectedTenantId, tenantId)))
  return { removed: removed.length > 0 }
}

// ---- Users ----------------------------------------------------------------------------------

const tenantCountSql = sql<number>`(SELECT count(*)::int FROM tenant_users tu WHERE tu.user_id = ${users.id})`

function toAdminUser(row: User, tenantCount: number): AdminUserListItem {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isGlobalAdmin: row.isGlobalAdmin,
    emailVerifiedAt: row.emailVerifiedAt,
    lastLoginAt: row.lastLoginAt,
    blockedAt: row.blockedAt,
    tenantCount,
    createdAt: row.createdAt,
  }
}

export async function listAdminUsers(db: Database, query: AdminUserListQuery) {
  const { limit, offset } = pageWindow(query)
  const filters = [
    query.q ? or(ilike(users.email, `%${query.q}%`), ilike(users.name, `%${query.q}%`)) : undefined,
    query.filter === 'global_admin' ? eq(users.isGlobalAdmin, true) : undefined,
    query.filter === 'blocked' ? isNotNull(users.blockedAt) : undefined,
    query.filter === 'no_tenant' ? sql`${tenantCountSql} = 0` : undefined,
    query.tenantId
      ? inArray(
          users.id,
          db
            .select({ id: tenantUsers.userId })
            .from(tenantUsers)
            .where(eq(tenantUsers.tenantId, query.tenantId))
        )
      : undefined,
  ]
  const where = and(...filters)
  const [rows, [count]] = await Promise.all([
    db
      .select({ user: users, tenantCount: tenantCountSql })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(users).where(where),
  ])
  return {
    items: rows.map(r => toAdminUser(r.user, Number(r.tenantCount))),
    total: asCount(count?.count),
  }
}

export async function getAdminUser(db: Database, userId: string): Promise<AdminUserDetail> {
  const [row] = await db
    .select({ user: users, tenantCount: tenantCountSql })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row) throw new NotFoundError('User not found')
  const [memberships, providers] = await Promise.all([
    db
      .select({
        tenantId: tenantUsers.tenantId,
        name: tenants.name,
        slug: tenants.slug,
        role: tenantUsers.role,
        joinedAt: tenantUsers.joinedAt,
      })
      .from(tenantUsers)
      .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
      .where(eq(tenantUsers.userId, userId))
      .orderBy(asc(tenantUsers.joinedAt)),
    db
      .select({ provider: oauthProviders.provider, createdAt: oauthProviders.createdAt })
      .from(oauthProviders)
      .where(eq(oauthProviders.userId, userId)),
  ])
  return { ...toAdminUser(row.user, Number(row.tenantCount)), memberships, providers }
}

export async function setGlobalAdmin(
  db: Database,
  input: { userId: string; isGlobalAdmin: boolean; actor: User }
) {
  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) })
  if (!target) throw new NotFoundError('User not found')
  if (!input.isGlobalAdmin && target.isGlobalAdmin) {
    const [row] = await db
      .select({ count: sql`count(*)` })
      .from(users)
      .where(eq(users.isGlobalAdmin, true))
    if (asCount(row?.count) <= 1) {
      throw new ConflictError('At least one global admin must remain', 'last_global_admin')
    }
  }
  const [updated] = await db
    .update(users)
    .set({ isGlobalAdmin: input.isGlobalAdmin })
    .where(eq(users.id, input.userId))
    .returning()
  return updated ?? target
}

/** Blocking deletes every session — the account is out immediately, not at the next expiry. */
export async function setUserBlocked(db: Database, input: { userId: string; blocked: boolean }) {
  const [updated] = await db
    .update(users)
    .set({ blockedAt: input.blocked ? new Date() : null })
    .where(eq(users.id, input.userId))
    .returning()
  if (!updated) throw new NotFoundError('User not found')
  if (input.blocked) await deleteUserSessions(db, input.userId)
  return updated
}
