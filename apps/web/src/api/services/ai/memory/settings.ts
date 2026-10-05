/**
 * Is memory on for this person here (D36)? Two switches, both required, read in ONE place:
 *
 * 1. the `memory` feature flag (D30) — the ORGANISATION's decision, rolled out per tenant;
 * 2. the person's own `preferences.memory.enabled` — absent means on, `false` means off.
 *
 * Background work has no `AuthContext`, so it cannot read `auth.features`; it resolves the flag
 * here with the person as the subject, which is the same answer their session got (`resolveFeatures`
 * is the one evaluator, and a user-bucketed rollout is bucketed on the same id).
 */
import { MEMORY_PREFERENCE_KEY, memoryOptedOut } from '@rocketflare/shared/ai/memory'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { tenantUserSettings } from '../../../../db/schema'
import { resolveFeatures } from '../../../../permissions/features'
import { listFeatureFlagRows } from '../../features'
import { updateUserPreferences } from '../../tenants'

/** The organisation's switch, for a person (or for nobody — then never on). */
export async function memoryAvailable(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string | null
): Promise<boolean> {
  if (!userId) return false
  const rows = await listFeatureFlagRows(db, tenantId)
  return resolveFeatures(cfg, rows, { tenantId, userId }).includes('memory')
}

/** The person's switch. No settings row reads as "not opted out". */
export async function memoryOptedOutFor(
  db: Database,
  tenantId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ preferences: tenantUserSettings.preferences })
    .from(tenantUserSettings)
    .where(and(eq(tenantUserSettings.tenantId, tenantId), eq(tenantUserSettings.userId, userId)))
    .limit(1)
  return memoryOptedOut(row?.preferences)
}

/**
 * Both switches. `features` short-cuts the flag when the caller already holds a request's
 * resolved list (`auth.features`), so a chat turn costs one query here, not two.
 */
export async function memoryEnabledFor(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  userId: string | null,
  features?: readonly string[]
): Promise<boolean> {
  if (!userId) return false
  const available = features
    ? features.includes('memory')
    : await memoryAvailable(db, cfg, tenantId, userId)
  if (!available) return false
  return !(await memoryOptedOutFor(db, tenantId, userId))
}

export async function setMemoryEnabled(
  db: Database,
  tenantId: string,
  userId: string,
  enabled: boolean
): Promise<void> {
  await updateUserPreferences(db, tenantId, userId, { [MEMORY_PREFERENCE_KEY]: { enabled } })
}
