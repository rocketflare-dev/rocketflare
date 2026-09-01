/**
 * DB-backed cookie sessions (D12): the cookie holds a random token, the row holds its SHA-256.
 * `resolveSession` is the ONE query behind every cookie-authenticated request — session + user +
 * best membership + tenant + pending access request through LATERAL joins (the Workers reference
 * app's pattern), so the auth middleware costs one round trip however far the Worker is from
 * Postgres. Sliding 30-day expiry: `touchSession` extends at most hourly (SQL-throttled) and is
 * called through `waitUntil`, never awaited on the response path.
 */
import type { MembershipRole, TenantStatus } from '@gmgo/shared/tenants'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { tenants, type User, userSessions, users } from '../../db/schema'
import { hashToken } from '../utils/core/hash'
import { randomToken } from '../utils/core/ids'
import { SESSION_TTL_MS } from './cookies'

export interface CreateSessionInput {
  userId: string
  selectedTenantId?: string | null
  ip?: string | null
  userAgent?: string | null
}

export interface CreatedSession {
  /** The cookie value. Never stored. */
  token: string
  id: string
  expiresAt: Date
}

export async function createSession(
  db: Database,
  input: CreateSessionInput
): Promise<CreatedSession> {
  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const [row] = await db
    .insert(userSessions)
    .values({
      userId: input.userId,
      tokenHash: await hashToken(token),
      selectedTenantId: input.selectedTenantId ?? null,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
    })
    .returning({ id: userSessions.id })
  if (!row) throw new Error('createSession: insert returned no row')
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, input.userId))
  return { token, id: row.id, expiresAt }
}

export interface ResolvedMembership {
  tenantId: string
  role: MembershipRole
  tenant: { id: string; name: string; slug: string; status: TenantStatus }
}

export interface ResolvedSession {
  session: { id: string; expiresAt: Date; lastSeenAt: Date; selectedTenantId: string | null }
  user: User
  /** The selected tenant while the membership is valid, else the oldest membership, else null. */
  membership: ResolvedMembership | null
  /** Latest access request for the user's email, if any. */
  accessRequestStatus: 'pending' | 'approved' | 'rejected' | null
}

interface SessionRow {
  session_id: string
  expires_at: Date | string
  last_seen_at: Date | string
  selected_tenant_id: string | null
  user_id: string
  email: string
  name: string
  avatar_url: string | null
  is_global_admin: boolean
  email_verified_at: Date | string | null
  last_login_at: Date | string | null
  blocked_at: Date | string | null
  user_created_at: Date | string
  user_updated_at: Date | string
  membership_tenant_id: string | null
  membership_role: MembershipRole | null
  tenant_name: string | null
  tenant_slug: string | null
  tenant_status: TenantStatus | null
  access_request_status: 'pending' | 'approved' | 'rejected' | null
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v))
const asDateOrNull = (v: Date | string | null): Date | null => (v === null ? null : asDate(v))

/** One round trip: session → user → best membership → tenant → latest access request. */
export async function resolveSession(db: Database, token: string): Promise<ResolvedSession | null> {
  const tokenHash = await hashToken(token)
  const rows = (await db.execute(sql`
    SELECT
      us.id                    AS session_id,
      us.expires_at,
      us.last_seen_at,
      us.selected_tenant_id,
      u.id                     AS user_id,
      u.email, u.name, u.avatar_url, u.is_global_admin, u.email_verified_at, u.last_login_at,
      u.blocked_at,
      u.created_at             AS user_created_at,
      u.updated_at             AS user_updated_at,
      m.tenant_id              AS membership_tenant_id,
      m.role                   AS membership_role,
      t.name                   AS tenant_name,
      t.slug                   AS tenant_slug,
      t.status                 AS tenant_status,
      ar.status                AS access_request_status
    FROM user_sessions us
    INNER JOIN users u ON u.id = us.user_id
    LEFT JOIN LATERAL (
      SELECT tu.tenant_id, tu.role
      FROM tenant_users tu
      WHERE tu.user_id = u.id
      ORDER BY (tu.tenant_id = us.selected_tenant_id) DESC NULLS LAST, tu.joined_at ASC
      LIMIT 1
    ) m ON true
    LEFT JOIN tenants t ON t.id = m.tenant_id
    LEFT JOIN LATERAL (
      SELECT a.status
      FROM access_requests a
      WHERE lower(a.email) = lower(u.email)
      ORDER BY a.created_at DESC
      LIMIT 1
    ) ar ON true
    WHERE us.token_hash = ${tokenHash}
    LIMIT 1
  `)) as unknown as SessionRow[]
  const row = rows[0]
  if (!row) return null

  const user: User = {
    id: row.user_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    isGlobalAdmin: row.is_global_admin,
    emailVerifiedAt: asDateOrNull(row.email_verified_at),
    lastLoginAt: asDateOrNull(row.last_login_at),
    blockedAt: asDateOrNull(row.blocked_at),
    createdAt: asDate(row.user_created_at),
    updatedAt: asDate(row.user_updated_at),
  }
  const membership: ResolvedMembership | null =
    row.membership_tenant_id && row.membership_role && row.tenant_name && row.tenant_slug
      ? {
          tenantId: row.membership_tenant_id,
          role: row.membership_role,
          tenant: {
            id: row.membership_tenant_id,
            name: row.tenant_name,
            slug: row.tenant_slug,
            status: row.tenant_status ?? 'active',
          },
        }
      : null
  return {
    session: {
      id: row.session_id,
      expiresAt: asDate(row.expires_at),
      lastSeenAt: asDate(row.last_seen_at),
      selectedTenantId: row.selected_tenant_id,
    },
    user,
    membership,
    accessRequestStatus: row.access_request_status,
  }
}

/** Slide the expiry; the SQL predicate makes it a no-op unless the last touch is > 1 hour old. */
export async function touchSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(
      and(
        eq(userSessions.id, sessionId),
        lt(userSessions.lastSeenAt, sql`now() - interval '1 hour'`)
      )
    )
}

/** Throttled `tenants.last_accessed_at` (once an hour) — drives idle-tenant housekeeping. */
export async function touchTenantAccess(db: Database, tenantId: string): Promise<void> {
  await db
    .update(tenants)
    .set({ lastAccessedAt: new Date() })
    .where(
      and(
        eq(tenants.id, tenantId),
        or(
          isNull(tenants.lastAccessedAt),
          lt(tenants.lastAccessedAt, sql`now() - interval '1 hour'`)
        )
      )
    )
}

export async function updateSelectedTenant(
  db: Database,
  sessionId: string,
  tenantId: string | null
): Promise<void> {
  await db
    .update(userSessions)
    .set({ selectedTenantId: tenantId })
    .where(eq(userSessions.id, sessionId))
}

export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(userSessions).where(eq(userSessions.id, sessionId))
}

/** Logout everywhere / block: every session of one user. */
export async function deleteUserSessions(db: Database, userId: string): Promise<number> {
  const rows = await db
    .delete(userSessions)
    .where(eq(userSessions.userId, userId))
    .returning({ id: userSessions.id })
  return rows.length
}
