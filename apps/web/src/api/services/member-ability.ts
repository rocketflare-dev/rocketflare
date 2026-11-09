/**
 * The grant somebody holds in a tenant RIGHT NOW, for the paths with no auth context: a plugin's
 * public callback acting on a token minted earlier, and an agent run reading its requester at
 * execute time. Built from the same `buildAbility` the auth middleware uses.
 *
 * `null` for no membership, a blocked account or a suspended tenant — the cases the auth middleware
 * answers 401/403 for on a session, which these paths never go through.
 */
import type { Actions, AppAbility, Subjects } from '@rocketflare/shared/permissions'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { tenants, tenantUsers, users } from '../../db/schema'
import { buildAbility, resolveFeatures } from '../../permissions'
import { listFeatureFlagRows } from './features'

export type AbilityCheck = (action: Actions, subject: Subjects) => boolean

export async function memberAbility(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string
): Promise<AppAbility | null> {
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
  const features = resolveFeatures(cfg, await listFeatureFlagRows(db, tenantId), {
    tenantId,
    userId,
  })
  return buildAbility({ role: row.role, isGlobalAdmin: row.isGlobalAdmin, features })
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
