/**
 * Connections (grants) as people see them: an admin lists and revokes every connection in their
 * organisation; a person lists and revokes their own across organisations. And the lifecycle rule
 * — a person removed from an organisation, or blocked, loses their connections there in the same
 * transaction, the way their pending invitations end.
 *
 * Revocation is a column (`revoked_at`), read on every `/mcp` call and every refresh, so it takes
 * effect on the client's next request. A connection that has ended stays in the list with how it
 * ended, so an admin can still see who connected what.
 */
import type { McpScope } from '@rocketflare/shared/mcp'
import type { McpConnection } from '@rocketflare/shared/oauth'
import { and, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { mcpGrants, mcpToolCalls, oauthClients, tenants, users } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { recordActivity } from '../activity'
import { mcpGrantLapsed } from './tokens'

const DAY_MS = 24 * 60 * 60 * 1000

export type ConnectionStatusFilter = 'live' | 'all'

function statusOf(
  cfg: AppConfig,
  grant: { revokedAt: Date | null; expiresAt: Date; lastUsedAt: Date },
  now: Date
): McpConnection['status'] {
  if (grant.revokedAt) return 'revoked'
  if (grant.expiresAt.getTime() <= now.getTime()) return 'expired'
  return mcpGrantLapsed(cfg, grant, now) ? 'idle' : 'live'
}

/** Connections in one organisation (`tenantId`) or of one person (`userId`), newest first. */
export async function listMcpConnections(
  db: Database,
  cfg: AppConfig,
  filter: { tenantId?: string; userId?: string; status: ConnectionStatusFilter },
  now = new Date()
): Promise<McpConnection[]> {
  const rows = await db
    .select({
      grant: mcpGrants,
      tenant: { id: tenants.id, name: tenants.name, slug: tenants.slug },
      user: { id: users.id, email: users.email, name: users.name },
      clientName: oauthClients.clientName,
    })
    .from(mcpGrants)
    .innerJoin(tenants, eq(tenants.id, mcpGrants.tenantId))
    .innerJoin(users, eq(users.id, mcpGrants.userId))
    .leftJoin(oauthClients, eq(oauthClients.clientId, mcpGrants.clientId))
    .where(
      and(
        filter.tenantId ? eq(mcpGrants.tenantId, filter.tenantId) : undefined,
        filter.userId ? eq(mcpGrants.userId, filter.userId) : undefined,
        filter.status === 'live' ? isNull(mcpGrants.revokedAt) : undefined
      )
    )
    .orderBy(desc(mcpGrants.createdAt))
    .limit(500)
  const ids = rows.map(r => r.grant.id)
  const counts = new Map<string, number>()
  if (ids.length > 0) {
    const tenantIds = [...new Set(rows.map(r => r.grant.tenantId))]
    const calls = await db
      .select({ grantId: mcpToolCalls.grantId, calls: count() })
      .from(mcpToolCalls)
      .where(
        and(
          inArray(mcpToolCalls.tenantId, tenantIds),
          inArray(mcpToolCalls.grantId, ids),
          gte(mcpToolCalls.createdAt, new Date(now.getTime() - 30 * DAY_MS))
        )
      )
      .groupBy(mcpToolCalls.grantId)
    for (const c of calls) if (c.grantId) counts.set(c.grantId, Number(c.calls))
  }
  return rows
    .map(({ grant, tenant, user, clientName }) => ({
      id: grant.id,
      tenant,
      user,
      client: {
        clientId: grant.clientId,
        name: clientName ?? null,
        verifiedHost: hostOf(grant.clientId),
      },
      scopes: grant.scopes as McpScope[],
      resource: grant.resource,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      expiresAt: grant.expiresAt,
      calls30d: counts.get(grant.id) ?? 0,
      status: statusOf(cfg, grant, now),
      revokedAt: grant.revokedAt,
      revokeReason: grant.revokeReason,
    }))
    .filter(c => filter.status === 'all' || c.status === 'live')
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}

type Revoker = { byUserId: string | null; reason: string; by: 'admin' | 'self' | 'lifecycle' }

/** Revoke the given live grants, one activity row each. Answers how many ended. */
async function revokeWhere(
  db: Database,
  where: ReturnType<typeof and>,
  revoker: Revoker,
  now: Date
): Promise<number> {
  const ended = await db
    .update(mcpGrants)
    .set({ revokedAt: now, revokedByUserId: revoker.byUserId, revokeReason: revoker.reason })
    .where(and(where, isNull(mcpGrants.revokedAt)))
    .returning({
      id: mcpGrants.id,
      tenantId: mcpGrants.tenantId,
      clientId: mcpGrants.clientId,
      userId: mcpGrants.userId,
    })
  for (const grant of ended) {
    await recordActivity(db, {
      tenantId: grant.tenantId,
      userId: revoker.byUserId,
      type: 'mcp.client_revoked',
      subjectType: 'McpGrant',
      subjectId: grant.id,
      metadata: {
        clientId: grant.clientId,
        userId: grant.userId,
        reason: revoker.reason,
        by: revoker.by,
      },
    })
  }
  return ended.length
}

/** An admin revokes one connection in their organisation; 404 for one that is not in it. */
export async function revokeTenantConnection(
  db: Database,
  input: { tenantId: string; grantId: string; actorUserId: string },
  now = new Date()
): Promise<void> {
  const [grant] = await db
    .select({ id: mcpGrants.id })
    .from(mcpGrants)
    .where(and(eq(mcpGrants.tenantId, input.tenantId), eq(mcpGrants.id, input.grantId)))
  if (!grant) throw new NotFoundError('Connection not found')
  await revokeWhere(
    db,
    and(eq(mcpGrants.tenantId, input.tenantId), eq(mcpGrants.id, input.grantId)),
    { byUserId: input.actorUserId, reason: 'revoked_by_admin', by: 'admin' },
    now
  )
}

/** "Revoke all" — every live connection in the organisation. */
export function revokeAllTenantConnections(
  db: Database,
  input: { tenantId: string; actorUserId: string },
  now = new Date()
): Promise<number> {
  return revokeWhere(
    db,
    and(eq(mcpGrants.tenantId, input.tenantId)),
    { byUserId: input.actorUserId, reason: 'revoked_by_admin', by: 'admin' },
    now
  )
}

/** A person revokes one of their own connections (any organisation); 404 for anyone else's. */
export async function revokeOwnConnection(
  db: Database,
  input: { userId: string; grantId: string },
  now = new Date()
): Promise<void> {
  const [grant] = await db
    .select({ id: mcpGrants.id })
    .from(mcpGrants)
    .where(and(eq(mcpGrants.userId, input.userId), eq(mcpGrants.id, input.grantId)))
  if (!grant) throw new NotFoundError('Connection not found')
  await revokeWhere(
    db,
    and(eq(mcpGrants.userId, input.userId), eq(mcpGrants.id, input.grantId)),
    { byUserId: input.userId, reason: 'revoked_by_user', by: 'self' },
    now
  )
}

/**
 * The lifecycle rule, for the caller's transaction: removing someone from an organisation
 * (`tenantId`) or blocking them (every organisation) ends their connections there. Role, group
 * and policy changes need nothing — every call re-reads them.
 */
export function revokeMcpGrantsOf(
  tx: Database,
  input: {
    userId: string
    tenantId?: string
    reason: 'member_removed' | 'blocked'
    actorUserId?: string
  },
  now = new Date()
): Promise<number> {
  return revokeWhere(
    tx,
    and(
      eq(mcpGrants.userId, input.userId),
      input.tenantId ? eq(mcpGrants.tenantId, input.tenantId) : undefined
    ),
    { byUserId: input.actorUserId ?? null, reason: input.reason, by: 'lifecycle' },
    now
  )
}
