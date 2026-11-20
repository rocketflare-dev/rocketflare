/**
 * The grant somebody holds in a tenant RIGHT NOW, for the paths with no auth context: a plugin's
 * public callback acting on a token minted earlier, and an agent run reading its requester at
 * execute time. Built from the same `buildAbility` the auth middleware uses.
 *
 * `null` for no membership, a blocked account or a suspended tenant — the cases the auth middleware
 * answers 401/403 for on a session, which these paths never go through.
 */
import type { Actions, AppAbility, Subjects } from '@rocketflare/shared/permissions'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { tenants, tenantUsers, users } from '../../db/schema'
import { buildAbility, resolveFeatures } from '../../permissions'
import { isAdminLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import type { AccessScope } from './access-sql'
import type { ToolRequester } from './agents/tools/search-knowledge'
import { listFeatureFlagRows } from './features'
import { listUserGroups } from './groups'

export type AbilityCheck = (action: Actions, subject: Subjects) => boolean

export async function memberAbility(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string
): Promise<AppAbility | null> {
  return (await memberGrant(db, cfg, tenantId, userId))?.ability ?? null
}

async function memberGrant(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string
): Promise<{ ability: AppAbility; role: MembershipRole; isGlobalAdmin: boolean } | null> {
  const [row] = await db
    .select({
      role: tenantUsers.role,
      isGlobalAdmin: users.isGlobalAdmin,
      blockedAt: users.blockedAt,
      status: tenants.status,
    })
    .from(tenantUsers)
    .innerJoin(users, eq(users.id, tenantUsers.userId))
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
    .limit(1)
  if (!row || row.blockedAt || row.status === 'suspended') return null
  const features = await resolveFeatures(cfg, await listFeatureFlagRows(db, tenantId), {
    tenantId,
    userId,
  })
  return {
    ability: buildAbility({ role: row.role, isGlobalAdmin: row.isGlobalAdmin, features }),
    role: row.role,
    isGlobalAdmin: row.isGlobalAdmin,
  }
}

/** `can` for one requester, or the answer "no" to everything when there is none. */
export async function requesterCan(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string | null
): Promise<AbilityCheck> {
  const ability = userId ? await memberAbility(db, cfg, tenantId, userId) : null
  return (action, subject) => ability?.can(action, subject) ?? false
}

/**
 * Everything an off-request run's tools need about its requester, read at execute time: the read
 * scope (the same as `accessScopeForUser` — the person's groups, no bypass), the CASL check, and
 * the `ToolRequester` (absent with no requester, or when they no longer hold a membership — the
 * same cases `can` answers "no" to everything for). One membership read and one groups read.
 */
export async function runRequester(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string | null
): Promise<{ scope: AccessScope; can: AbilityCheck; requester?: ToolRequester }> {
  if (!userId) {
    return { scope: { tenantId, userId: null, groupIds: [], bypass: false }, can: () => false }
  }
  const [grant, groups] = await Promise.all([
    memberGrant(db, cfg, tenantId, userId),
    listUserGroups(db, tenantId, userId),
  ])
  const scope: AccessScope = { tenantId, userId, groupIds: groups.map(g => g.id), bypass: false }
  if (!grant) return { scope, can: () => false }
  const role = grant.role
  return {
    scope,
    can: (action, subject) => grant.ability.can(action, subject),
    requester: {
      userId,
      role,
      isAdmin: isAdminLevel({ isGlobalAdmin: grant.isGlobalAdmin, tenantUser: { role } }),
      groups,
    },
  }
}

/** The `ToolRequester` of a request that already holds its auth context (chat, the MCP server). */
export function authRequester(auth: AuthContext): ToolRequester {
  return {
    userId: auth.user.id,
    role: auth.tenantUser?.role ?? null,
    isAdmin: isAdminLevel(auth),
    groups: auth.groups,
  }
}
