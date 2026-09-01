/**
 * Sign-up gating and login plumbing (D9, D25). `admitUser` is the ONE function every login path
 * (magic link, OAuth, invite accept, dev-login bypasses it) runs to turn a verified email into a
 * user row — or a refusal. `onNoTenant` is the one hook that decides what a member-less user
 * gets: the single tenant, a personal workspace, or nothing (→ /pending or /select-tenant).
 * `buildSessionResponse` is `/auth/session`'s body, also returned by select-tenant and accept.
 */
import type { SessionResponse, TenantSummary } from '@rocketflare/shared/auth'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import {
  accessRequests,
  teamInvitations,
  tenants,
  tenantUsers,
  type User,
  users,
} from '../../db/schema'
import { packRules } from '../../permissions'
import type { AuthContext } from '../types'
import type { Logger } from '../utils/core/logger'
import { createTenantForUser, getSingleTenant } from '../utils/db/tenant-helpers'
import { recordActivity } from './activity'

export interface AdmitInput {
  email: string
  name?: string | null
  /** The login proved ownership of the address (magic link; provider said verified). */
  verified: boolean
  avatarUrl?: string | null
}

export type AdmitResult =
  | { ok: true; user: User; created: boolean }
  | { ok: false; reason: 'not_invited' | 'blocked' }

export type AdmitLogger = Pick<Logger, 'info' | 'warn'>

/** `"jane.doe@x"` → `"Jane Doe"` when the provider gave no name. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'user'
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  return words.join(' ') || 'User'
}

export function isBootstrapAdmin(cfg: AppConfig, email: string): boolean {
  return cfg.BOOTSTRAP_ADMIN_EMAILS.includes(email.toLowerCase())
}

export async function findUserByEmail(db: Database, email: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email.toLowerCase()}` })
}

export async function hasPendingInvitation(db: Database, email: string): Promise<boolean> {
  const row = await db.query.teamInvitations.findFirst({
    columns: { id: true },
    where: and(
      sql`lower(${teamInvitations.email}) = ${email.toLowerCase()}`,
      isNull(teamInvitations.acceptedAt),
      isNull(teamInvitations.revokedAt),
      sql`${teamInvitations.expiresAt} > now()`
    ),
  })
  return Boolean(row)
}

export async function membershipCount(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tenantUsers)
    .where(eq(tenantUsers.userId, userId))
  return Number(row?.count ?? 0)
}

async function createUser(
  db: Database,
  input: AdmitInput,
  extra: { isGlobalAdmin: boolean }
): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      name: input.name?.trim() || nameFromEmail(input.email),
      avatarUrl: input.avatarUrl ?? null,
      isGlobalAdmin: extra.isGlobalAdmin,
      emailVerifiedAt: input.verified ? new Date() : null,
    })
    .returning()
  if (!user) throw new Error('admitUser: insert returned no row')
  return user
}

/**
 * Turn a login into a user row, or refuse. Pure decision + writes; never throws for gating so
 * redirect-based callers can map `reason` to `/login?error=<code>`.
 */
export async function admitUser(
  db: Database,
  cfg: AppConfig,
  input: AdmitInput,
  logger: AdmitLogger
): Promise<AdmitResult> {
  const email = input.email.toLowerCase()
  const bootstrap = input.verified && isBootstrapAdmin(cfg, email)

  const existing = await findUserByEmail(db, email)
  if (existing) {
    if (existing.blockedAt) return { ok: false, reason: 'blocked' }
    const patch: Partial<typeof users.$inferInsert> = {}
    if (input.verified && !existing.emailVerifiedAt) patch.emailVerifiedAt = new Date()
    if (bootstrap && !existing.isGlobalAdmin) {
      patch.isGlobalAdmin = true
      logger.warn(
        { email },
        'BOOTSTRAP_ADMIN_EMAILS: promoted an existing user to GLOBAL ADMIN on verified login'
      )
    }
    if (input.avatarUrl && !existing.avatarUrl) patch.avatarUrl = input.avatarUrl
    let user = existing
    if (Object.keys(patch).length > 0) {
      const [updated] = await db
        .update(users)
        .set(patch)
        .where(eq(users.id, existing.id))
        .returning()
      user = updated ?? existing
    }
    if (bootstrap && (await membershipCount(db, user.id)) === 0) {
      await onNoTenant(db, cfg, user, logger)
    }
    return { ok: true, user, created: false }
  }

  if (bootstrap) {
    const user = await createUser(db, { ...input, email }, { isGlobalAdmin: true })
    logger.warn(
      { email },
      'BOOTSTRAP_ADMIN_EMAILS: created the first GLOBAL ADMIN on verified login'
    )
    await onNoTenant(db, cfg, user, logger)
    return { ok: true, user, created: true }
  }

  if (await hasPendingInvitation(db, email)) {
    // Membership comes from accepting the invitation; any SIGNUP_MODE admits an invitee.
    const user = await createUser(db, { ...input, email }, { isGlobalAdmin: false })
    return { ok: true, user, created: true }
  }

  switch (cfg.SIGNUP_MODE) {
    case 'invite_only':
      return { ok: false, reason: 'not_invited' }
    case 'open': {
      const user = await createUser(db, { ...input, email }, { isGlobalAdmin: false })
      await onNoTenant(db, cfg, user, logger)
      return { ok: true, user, created: true }
    }
    case 'approval': {
      const user = await createUser(db, { ...input, email }, { isGlobalAdmin: false })
      await ensureAccessRequest(db, { email, userId: user.id })
      return { ok: true, user, created: true }
    }
  }
}

/** One pending request per email; re-login updates `userId` on the open row instead of duplicating. */
export async function ensureAccessRequest(
  db: Database,
  input: {
    email: string
    userId: string | null
    message?: string | null
    requestedTenantId?: string | null
  }
) {
  const email = input.email.toLowerCase()
  const pending = await db.query.accessRequests.findFirst({
    where: and(eq(accessRequests.email, email), eq(accessRequests.status, 'pending')),
  })
  if (pending) {
    const [row] = await db
      .update(accessRequests)
      .set({
        userId: input.userId ?? pending.userId,
        message: input.message ?? pending.message,
        requestedTenantId: input.requestedTenantId ?? pending.requestedTenantId,
      })
      .where(eq(accessRequests.id, pending.id))
      .returning()
    return row ?? pending
  }
  const [row] = await db
    .insert(accessRequests)
    .values({
      email,
      userId: input.userId,
      message: input.message ?? null,
      requestedTenantId: input.requestedTenantId ?? null,
    })
    .returning()
  if (!row) throw new Error('ensureAccessRequest: insert returned no row')
  return row
}

/**
 * What a member-less user gets (D9/D25):
 *   single           → join the one tenant as `member` (a bootstrap admin creates it if missing)
 *   multi + open     → a personal workspace as `owner`
 *   otherwise        → nothing; the session has no tenant (→ /pending or /select-tenant)
 */
export async function onNoTenant(
  db: Database,
  cfg: AppConfig,
  user: User,
  logger: AdmitLogger
): Promise<string | null> {
  if (cfg.TENANCY_MODE === 'single') {
    const single = await getSingleTenant(db)
    if (!single) {
      if (!user.isGlobalAdmin) return null
      const created = await createTenantForUser(db, {
        name: cfg.APP_NAME,
        slug: 'default',
        userId: user.id,
        role: 'owner',
      })
      logger.warn(
        { tenantId: created.id },
        'TENANCY_MODE=single: bootstrap admin created the tenant'
      )
      return created.id
    }
    await db
      .insert(tenantUsers)
      .values({ tenantId: single.id, userId: user.id, role: 'member' })
      .onConflictDoNothing()
    await recordActivity(db, {
      tenantId: single.id,
      userId: user.id,
      type: 'member.joined',
      subjectType: 'TenantMember',
      subjectId: user.id,
      metadata: { via: 'single_tenant_auto_join' },
    })
    return single.id
  }
  if (cfg.SIGNUP_MODE === 'open') {
    const tenant = await createTenantForUser(db, {
      name: `${user.name}'s workspace`,
      userId: user.id,
      role: 'owner',
    })
    return tenant.id
  }
  return null
}

/** Oldest membership → the tenant a fresh session selects. */
export async function defaultTenantFor(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: tenantUsers.tenantId })
    .from(tenantUsers)
    .where(eq(tenantUsers.userId, userId))
    .orderBy(tenantUsers.joinedAt)
    .limit(1)
  return row?.tenantId ?? null
}

export async function listTenantSummaries(db: Database, userId: string): Promise<TenantSummary[]> {
  return db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, role: tenantUsers.role })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(eq(tenantUsers.userId, userId))
    .orderBy(tenantUsers.joinedAt)
}

export function toPublicUser(user: User): SessionResponse['user'] {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    isGlobalAdmin: user.isGlobalAdmin,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  }
}

export async function buildSessionResponse(
  db: Database,
  cfg: AppConfig,
  auth: AuthContext
): Promise<SessionResponse> {
  const summaries = await listTenantSummaries(db, auth.user.id)
  const current = auth.tenantId ? (summaries.find(t => t.id === auth.tenantId) ?? null) : null
  let accessRequest: SessionResponse['accessRequest'] = null
  if (!current) {
    const latest = await db.query.accessRequests.findFirst({
      columns: { status: true },
      where: sql`lower(${accessRequests.email}) = ${auth.user.email.toLowerCase()}`,
      orderBy: desc(accessRequests.createdAt),
    })
    if (latest && latest.status !== 'approved') accessRequest = { status: latest.status }
  }
  return {
    user: toPublicUser(auth.user),
    tenant: current,
    tenants: summaries,
    permissions: packRules(auth.ability),
    features: auth.features,
    accessRequest,
    tenancyMode: cfg.TENANCY_MODE,
    signupMode: cfg.SIGNUP_MODE,
    version: cfg.RELEASE_VERSION,
  }
}
