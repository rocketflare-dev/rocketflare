/**
 * Invitations (D9, D10, D12): create/bulk/resend/revoke inside a tenant, public details by token,
 * and the transactional accept. The URL token is 32 random bytes; only its SHA-256 is stored, so
 * "resend" mints a new token (the old link dies). Accept never demotes an existing higher role.
 */

import type { PaginationQuery } from '@gmgo/shared/pagination'
import type {
  Invitation,
  InvitationDetails,
  InvitationStatus,
  TenantRole,
} from '@gmgo/shared/tenants'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import {
  type TeamInvitation,
  teamInvitations,
  tenants,
  tenantUsers,
  type User,
  userSessions,
  users,
} from '../../db/schema'
import { ApiError, ConflictError, ForbiddenError, NotFoundError } from '../utils/core/errors'
import { hashToken } from '../utils/core/hash'
import { randomToken } from '../utils/core/ids'
import type { Logger } from '../utils/core/logger'
import { asCount, pageWindow } from '../utils/routes/pagination'
import { recordActivity } from './activity'
import { invitationEmail } from './email'
import { enqueueJob, type JobsQueue } from './jobs'
import { notify, notifyMany } from './notifications'
import { nudge, type Realtime, realtimeEvent } from './realtime'

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const ROLE_RANK: Record<string, number> = { member: 1, support: 2, admin: 2, owner: 3 }

export function invitationStatus(
  row: Pick<TeamInvitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>
): InvitationStatus {
  if (row.acceptedAt) return 'accepted'
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt.getTime() < Date.now()) return 'expired'
  return 'pending'
}

export function acceptUrl(cfg: AppConfig, token: string): string {
  return new URL(`/invite/${token}`, cfg.APP_URL).toString()
}

export function toInvitation(
  row: TeamInvitation,
  invitedByName: string | null,
  tenantName?: string
): Invitation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role,
    status: invitationStatus(row),
    invitedByUserId: row.invitedByUserId,
    invitedByName,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    ...(tenantName !== undefined ? { tenantName } : {}),
  }
}

const pendingWhere = (tenantId: string) =>
  and(
    eq(teamInvitations.tenantId, tenantId),
    isNull(teamInvitations.acceptedAt),
    isNull(teamInvitations.revokedAt),
    sql`${teamInvitations.expiresAt} > now()`
  )

export async function listInvitations(db: Database, tenantId: string, query: PaginationQuery) {
  const { limit, offset } = pageWindow(query)
  const [rows, [count]] = await Promise.all([
    db
      .select({ invitation: teamInvitations, invitedByName: users.name })
      .from(teamInvitations)
      .leftJoin(users, eq(users.id, teamInvitations.invitedByUserId))
      .where(pendingWhere(tenantId))
      .orderBy(desc(teamInvitations.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql`count(*)` }).from(teamInvitations).where(pendingWhere(tenantId)),
  ])
  return {
    items: rows.map(r => toInvitation(r.invitation, r.invitedByName)),
    total: asCount(count?.count),
  }
}

export interface InviteInput {
  tenantId: string
  email: string
  role: TenantRole
  inviter: User
  realtime?: Realtime
}

type InviteLogger = Pick<Logger, 'info' | 'warn' | 'error'>

/**
 * Invitation emails go through `JOBS_QUEUE` (D7): the route answers as soon as the row exists and
 * the consumer retries delivery. The magic-link email deliberately stays INLINE
 * (routes/auth/magic-link.ts) — a person is waiting on that one, so its latency matters more than
 * offloading it. A missing binding throws `JobsQueueNotConfiguredError`, never silently drops mail.
 */
async function queueInvitationEmail(
  jobs: JobsQueue,
  cfg: AppConfig,
  input: {
    to: string
    tenantId: string
    tenantName: string
    inviterName: string
    role: string
    token: string
  }
): Promise<void> {
  const message = invitationEmail(cfg, input.to, {
    tenantName: input.tenantName,
    inviterName: input.inviterName,
    role: input.role,
    acceptUrl: acceptUrl(cfg, input.token),
  })
  await enqueueJob(jobs, {
    type: 'email.send',
    payload: {
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      link: message.link,
      tenantId: input.tenantId,
      reason: 'invitation',
    },
  })
}

async function tenantName(db: Database, tenantId: string): Promise<string> {
  const row = await db.query.tenants.findFirst({
    columns: { name: true },
    where: eq(tenants.id, tenantId),
  })
  return row?.name ?? 'your organisation'
}

/** Insert the row and queue the email. Throws 409 when the address is a member or already invited. */
export async function createInvitation(
  db: Database,
  cfg: AppConfig,
  logger: InviteLogger,
  jobs: JobsQueue,
  input: InviteInput
): Promise<{ invitation: Invitation; token: string }> {
  const email = input.email.toLowerCase()
  const member = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .innerJoin(users, eq(users.id, tenantUsers.userId))
    .where(and(eq(tenantUsers.tenantId, input.tenantId), sql`lower(${users.email}) = ${email}`))
    .limit(1)
  if (member.length > 0)
    throw new ConflictError('Already a member of this organisation', 'already_member')

  const pending = await db.query.teamInvitations.findFirst({
    where: and(pendingWhere(input.tenantId), sql`lower(${teamInvitations.email}) = ${email}`),
  })
  if (pending)
    throw new ConflictError('An invitation is already pending for this address', 'already_invited')

  // A stale (expired) pending row would violate the partial unique index; revoke it first.
  await db
    .update(teamInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(teamInvitations.tenantId, input.tenantId),
        sql`lower(${teamInvitations.email}) = ${email}`,
        isNull(teamInvitations.acceptedAt),
        isNull(teamInvitations.revokedAt)
      )
    )

  const token = randomToken(32)
  const [row] = await db
    .insert(teamInvitations)
    .values({
      tenantId: input.tenantId,
      email,
      role: input.role,
      tokenHash: await hashToken(token),
      invitedByUserId: input.inviter.id,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    })
    .returning()
  if (!row) throw new Error('createInvitation: insert returned no row')

  await queueInvitationEmail(jobs, cfg, {
    to: email,
    tenantId: input.tenantId,
    tenantName: await tenantName(db, input.tenantId),
    inviterName: input.inviter.name,
    role: input.role,
    token,
  })
  nudge(input.realtime, realtimeEvent('invitation.changed', input.tenantId, { id: row.id }))
  return { invitation: toInvitation(row, input.inviter.name), token }
}

export interface BulkInviteOutcome {
  email: string
  status: 'invited' | 'skipped' | 'failed'
  reason?: string
  invitationId?: string
}

export async function bulkInvite(
  db: Database,
  cfg: AppConfig,
  logger: InviteLogger,
  jobs: JobsQueue,
  input: { tenantId: string; emails: string[]; role: TenantRole; inviter: User }
): Promise<BulkInviteOutcome[]> {
  const results: BulkInviteOutcome[] = []
  const seen = new Set<string>()
  for (const raw of input.emails) {
    const email = raw.toLowerCase()
    if (seen.has(email)) {
      results.push({ email, status: 'skipped', reason: 'duplicate' })
      continue
    }
    seen.add(email)
    try {
      const { invitation } = await createInvitation(db, cfg, logger, jobs, { ...input, email })
      results.push({ email, status: 'invited', invitationId: invitation.id })
    } catch (err) {
      if (err instanceof ConflictError) {
        results.push({ email, status: 'skipped', reason: err.code ?? 'conflict' })
      } else {
        logger.error({ err, email }, 'bulk invite failed for one address')
        results.push({ email, status: 'failed', reason: 'error' })
      }
    }
  }
  return results
}

/** New token + fresh 7-day expiry, email re-queued. Only pending invitations can be resent. */
export async function resendInvitation(
  db: Database,
  cfg: AppConfig,
  logger: InviteLogger,
  jobs: JobsQueue,
  input: { tenantId: string; id: string; inviter: User }
): Promise<Invitation> {
  const existing = await db.query.teamInvitations.findFirst({
    where: and(eq(teamInvitations.id, input.id), eq(teamInvitations.tenantId, input.tenantId)),
  })
  if (!existing) throw new NotFoundError('Invitation not found')
  if (existing.acceptedAt || existing.revokedAt) {
    throw new ConflictError('Only pending invitations can be resent', 'invitation_not_pending')
  }
  const token = randomToken(32)
  const [row] = await db
    .update(teamInvitations)
    .set({ tokenHash: await hashToken(token), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) })
    .where(eq(teamInvitations.id, existing.id))
    .returning()
  if (!row) throw new NotFoundError('Invitation not found')
  await queueInvitationEmail(jobs, cfg, {
    to: row.email,
    tenantId: input.tenantId,
    tenantName: await tenantName(db, input.tenantId),
    inviterName: input.inviter.name,
    role: row.role,
    token,
  })
  return toInvitation(row, input.inviter.name)
}

export async function revokeInvitation(
  db: Database,
  tenantId: string,
  id: string,
  realtime?: Realtime
): Promise<Invitation> {
  const row = await revokeRow(db, tenantId, id)
  nudge(realtime, realtimeEvent('invitation.changed', tenantId, { id }))
  return row
}

async function revokeRow(db: Database, tenantId: string, id: string): Promise<Invitation> {
  const [row] = await db
    .update(teamInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(teamInvitations.id, id),
        eq(teamInvitations.tenantId, tenantId),
        isNull(teamInvitations.acceptedAt),
        isNull(teamInvitations.revokedAt)
      )
    )
    .returning()
  if (!row) throw new NotFoundError('Pending invitation not found')
  return toInvitation(row, null)
}

async function findByToken(db: Database, token: string) {
  if (!token || token.length > 256) return undefined
  const tokenHash = await hashToken(token)
  const [row] = await db
    .select({
      invitation: teamInvitations,
      tenant: { name: tenants.name, slug: tenants.slug },
      invitedByName: users.name,
    })
    .from(teamInvitations)
    .innerJoin(tenants, eq(tenants.id, teamInvitations.tenantId))
    .leftJoin(users, eq(users.id, teamInvitations.invitedByUserId))
    .where(eq(teamInvitations.tokenHash, tokenHash))
    .limit(1)
  return row
}

/** What the public accept page may see. Null → 404. */
export async function getInvitationDetails(
  db: Database,
  token: string
): Promise<InvitationDetails | null> {
  const row = await findByToken(db, token)
  if (!row) return null
  return {
    email: row.invitation.email,
    role: row.invitation.role,
    status: invitationStatus(row.invitation),
    tenant: row.tenant,
    invitedByName: row.invitedByName,
    expiresAt: row.invitation.expiresAt,
  }
}

/**
 * Accept: ONE transaction — membership upsert (never demoting), `acceptedAt`, session points at
 * the tenant. The signed-in user's email must match the invitation (403 `invitation_email_mismatch`).
 */
export async function acceptInvitation(
  db: Database,
  input: { token: string; user: User; sessionId: string | null; realtime?: Realtime }
): Promise<{
  tenantId: string
  tenantName: string
  role: TenantRole
  invitation: TeamInvitation
  joined: boolean
}> {
  const row = await findByToken(db, input.token)
  if (!row) throw new NotFoundError('Invitation not found')
  const inv = row.invitation
  const status = invitationStatus(inv)
  if (status !== 'pending') {
    throw new ApiError(410, `This invitation is ${status}`, `invitation_${status}`)
  }
  if (inv.email.toLowerCase() !== input.user.email.toLowerCase()) {
    throw new ForbiddenError(
      'This invitation was sent to a different email address',
      'invitation_email_mismatch'
    )
  }

  const result = await db.transaction(async tx => {
    const existing = await tx.query.tenantUsers.findFirst({
      where: and(eq(tenantUsers.tenantId, inv.tenantId), eq(tenantUsers.userId, input.user.id)),
    })
    let joined = false
    if (!existing) {
      await tx.insert(tenantUsers).values({
        tenantId: inv.tenantId,
        userId: input.user.id,
        role: inv.role,
        invitedByUserId: inv.invitedByUserId,
      })
      joined = true
    } else if ((ROLE_RANK[inv.role] ?? 0) > (ROLE_RANK[existing.role] ?? 0)) {
      await tx
        .update(tenantUsers)
        .set({ role: inv.role })
        .where(and(eq(tenantUsers.tenantId, inv.tenantId), eq(tenantUsers.userId, input.user.id)))
    }
    await tx
      .update(teamInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(teamInvitations.id, inv.id))
    if (input.sessionId) {
      await tx
        .update(userSessions)
        .set({ selectedTenantId: inv.tenantId })
        .where(eq(userSessions.id, input.sessionId))
    }
    const txDb = tx as unknown as Database
    await recordActivity(txDb, {
      tenantId: inv.tenantId,
      userId: input.user.id,
      type: 'member.joined',
      subjectType: 'TenantMember',
      subjectId: input.user.id,
      metadata: { via: 'invitation', invitationId: inv.id, role: inv.role },
    })
    if (joined) {
      await notify(
        txDb,
        {
          tenantId: inv.tenantId,
          userId: inv.invitedByUserId,
          type: 'invitation_accepted',
          title: `${input.user.name} accepted your invitation`,
          body: `${input.user.email} joined ${row.tenant.name} as ${inv.role}.`,
          data: { userId: input.user.id, invitationId: inv.id },
        },
        input.realtime
      )
      const admins = await tx
        .select({ userId: tenantUsers.userId })
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, inv.tenantId),
            sql`${tenantUsers.role} IN ('owner', 'admin')`,
            sql`${tenantUsers.userId} <> ${inv.invitedByUserId}`,
            sql`${tenantUsers.userId} <> ${input.user.id}`
          )
        )
      await notifyMany(
        txDb,
        admins.map(a => a.userId),
        {
          tenantId: inv.tenantId,
          type: 'member_joined',
          title: `${input.user.name} joined ${row.tenant.name}`,
          body: `${input.user.email} joined as ${inv.role}.`,
          data: { userId: input.user.id },
        },
        input.realtime
      )
    }
    return {
      tenantId: inv.tenantId,
      tenantName: row.tenant.name,
      role: inv.role,
      invitation: inv,
      joined,
    }
  })
  // Two nudges, deliberately: the People page lists members AND pending invitations, and accept
  // changes both. Deferred, so they fire after the transaction has committed.
  nudge(input.realtime, realtimeEvent('invitation.changed', inv.tenantId, { id: inv.id }))
  if (result.joined) {
    nudge(input.realtime, realtimeEvent('member.changed', inv.tenantId, { id: input.user.id }))
  }
  return result
}

/** Pending invitations addressed to `email` across every tenant (cross-tenant by nature). */
export async function listPendingForEmail(db: Database, email: string): Promise<Invitation[]> {
  const rows = await db
    .select({ invitation: teamInvitations, tenantName: tenants.name, invitedByName: users.name })
    .from(teamInvitations)
    .innerJoin(tenants, eq(tenants.id, teamInvitations.tenantId))
    .leftJoin(users, eq(users.id, teamInvitations.invitedByUserId))
    .where(
      and(
        sql`lower(${teamInvitations.email}) = ${email.toLowerCase()}`,
        isNull(teamInvitations.acceptedAt),
        isNull(teamInvitations.revokedAt),
        sql`${teamInvitations.expiresAt} > now()`
      )
    )
    .orderBy(desc(teamInvitations.createdAt))
  return rows.map(r => toInvitation(r.invitation, r.invitedByName, r.tenantName))
}

/** Nightly prune: expired, never-accepted invitations older than 30 days. */
export async function pruneInvitations(db: Database): Promise<number> {
  const rows = await db
    .delete(teamInvitations)
    .where(
      and(
        isNull(teamInvitations.acceptedAt),
        sql`${teamInvitations.expiresAt} < now() - interval '30 days'`
      )
    )
    .returning({ id: teamInvitations.id })
  return rows.length
}
