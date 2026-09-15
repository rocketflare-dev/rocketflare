/**
 * Feature flags (D30) — the ONE place the stored half is read and written.
 *
 * Two readers with different shapes, deliberately:
 *
 *   - `listFeatureFlagRows(db, tenantId)` is the AUTH path's read: the raw rollout state plus this
 *     tenant's override, which `resolveFeatures` then evaluates. The cookie path gets the same rows
 *     out of `resolveSession`'s LATERAL instead, so this one serves Bearer requests and jobs.
 *   - `listFeatureFlags(db, cfg)` is the ADMIN view: the code registry joined to whatever has been
 *     saved, plus how many tenants override each flag.
 *
 * Writes are global-admin only (`globalAdminMiddleware` in `api/index.ts` is the gate; there is no
 * CASL condition here, as everywhere in the kit). Flag KEYS are never written — they come from the
 * shared registry, so these functions upsert state onto a known key and nothing can invent one.
 *
 * `listFlagOverrides` reads across tenants ON PURPOSE: "which organisations override this flag" is
 * the question the admin detail page asks, and it is reachable only behind `globalAdminMiddleware`.
 * It is the one query in this file that does not name a tenant.
 */
import {
  FEATURE_FLAGS,
  FEATURE_KEYS,
  type FeatureFlag,
  type FeatureFlagEvaluation,
  type TenantFeatureOverride,
  type UpdateFeatureFlagRequest,
} from '@rocketflare/shared/features'
import type { FeatureName } from '@rocketflare/shared/permissions'
import { and, eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { featureFlags, tenantFeatureOverrides, tenants } from '../../db/schema'
import { resolveFeatures } from '../../permissions/features'

/** Is this key permitted in this deployment at all (D30 layer 1)? */
export function availableInEnvironment(cfg: AppConfig, key: FeatureName): boolean {
  return !FEATURE_FLAGS[key].environmentGated || cfg.FEATURES_ENABLED.includes(key)
}

/**
 * The rollout state for one tenant, in the shape `resolveFeatures` evaluates. Mirrors the LATERAL
 * in `auth/sessions.ts` — if you change one, change both; `feature-flags.test.ts` asserts the two
 * paths agree for the same tenant.
 */
export async function listFeatureFlagRows(
  db: Database,
  tenantId: string | null
): Promise<FeatureFlagEvaluation[]> {
  const rows = await db
    .select({
      key: featureFlags.key,
      state: featureFlags.state,
      rolloutPercent: featureFlags.rolloutPercent,
      rolloutUnit: featureFlags.rolloutUnit,
      override: tenantFeatureOverrides.enabled,
    })
    .from(featureFlags)
    .leftJoin(
      tenantFeatureOverrides,
      and(
        eq(tenantFeatureOverrides.flagKey, featureFlags.key),
        // A session with no membership has no overrides to find; the platform state still applies.
        tenantId ? eq(tenantFeatureOverrides.tenantId, tenantId) : sql`false`
      )
    )
    .orderBy(featureFlags.key)
  // A row whose key has left the registry is inert — evaluation iterates the registry, not the rows
  // — but filtering here keeps the typed contract honest for everything downstream.
  return rows.filter((row): row is FeatureFlagEvaluation =>
    (FEATURE_KEYS as string[]).includes(row.key)
  )
}

/**
 * The features a deployment has with no tenant in hand — what a brand-new organisation is seeded
 * with (D30). A flag mid-ROLLOUT resolves false here, because the tenant it would be bucketed on
 * does not exist yet; its page then arrives on that tenant's first `GET /api/analytics/pages`
 * through the lazy repair path, which is late but never wrong. The environment layer, which is what
 * must never seed an unreleased surface, is decided correctly.
 */
export async function platformFeatures(db: Database, cfg: AppConfig): Promise<FeatureName[]> {
  const rows = await listFeatureFlagRows(db, null)
  return resolveFeatures(cfg, rows, { tenantId: null, userId: null })
}

/** The admin list: every registry entry, its saved state (if any) and its override count. */
export async function listFeatureFlags(db: Database, cfg: AppConfig): Promise<FeatureFlag[]> {
  const saved = await db
    .select({
      key: featureFlags.key,
      state: featureFlags.state,
      rolloutPercent: featureFlags.rolloutPercent,
      rolloutUnit: featureFlags.rolloutUnit,
      updatedAt: featureFlags.updatedAt,
      overrideCount: sql<number>`(
        select count(*)::int from tenant_feature_overrides o where o.flag_key = ${featureFlags.key}
      )`,
    })
    .from(featureFlags)
  const byKey = new Map(saved.map(row => [row.key, row]))

  return FEATURE_KEYS.map(key => {
    const definition = FEATURE_FLAGS[key]
    const row = byKey.get(key)
    return {
      key,
      label: definition.label,
      description: definition.description,
      state: row?.state ?? definition.defaultState,
      rolloutPercent: row?.rolloutPercent ?? 0,
      rolloutUnit: row?.rolloutUnit ?? definition.defaultRolloutUnit,
      environmentGated: definition.environmentGated,
      availableInEnvironment: availableInEnvironment(cfg, key),
      overrideCount: Number(row?.overrideCount ?? 0),
      updatedAt: row?.updatedAt ?? null,
    }
  })
}

/**
 * Upsert the platform state of one flag. The row may not exist yet — a flag is evaluated from its
 * registry default until somebody moves it — so this is an insert with an update on conflict.
 */
export async function updateFeatureFlag(
  db: Database,
  cfg: AppConfig,
  key: FeatureName,
  patch: UpdateFeatureFlagRequest,
  updatedByUserId: string
): Promise<FeatureFlag> {
  const definition = FEATURE_FLAGS[key]
  const current = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, key) })
  const next = {
    state: patch.state ?? current?.state ?? definition.defaultState,
    rolloutPercent: patch.rolloutPercent ?? current?.rolloutPercent ?? 0,
    rolloutUnit: patch.rolloutUnit ?? current?.rolloutUnit ?? definition.defaultRolloutUnit,
  }
  await db
    .insert(featureFlags)
    .values({ key, ...next, updatedByUserId })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { ...next, updatedByUserId, updatedAt: new Date() },
    })
  const [flag] = (await listFeatureFlags(db, cfg)).filter(f => f.key === key)
  if (!flag) throw new Error(`updateFeatureFlag: ${key} vanished from the registry`)
  return flag
}

/** Every override on one flag, across tenants — the admin detail page's table. */
export async function listFlagOverrides(
  db: Database,
  key: FeatureName
): Promise<TenantFeatureOverride[]> {
  const rows = await db
    .select({
      tenantId: tenantFeatureOverrides.tenantId,
      tenantName: tenants.name,
      flagKey: tenantFeatureOverrides.flagKey,
      enabled: tenantFeatureOverrides.enabled,
      updatedAt: tenantFeatureOverrides.updatedAt,
    })
    .from(tenantFeatureOverrides)
    .innerJoin(tenants, eq(tenants.id, tenantFeatureOverrides.tenantId))
    .where(eq(tenantFeatureOverrides.flagKey, key))
    .orderBy(tenants.name)
  return rows as TenantFeatureOverride[]
}

/**
 * Force a flag on or off for one tenant. The flag row is created first when it does not exist yet,
 * because the override carries a foreign key to it — an override on a flag nobody has configured is
 * a perfectly ordinary thing to want (ship it dark, then let one design partner in).
 */
export async function setTenantOverride(
  db: Database,
  key: FeatureName,
  tenantId: string,
  enabled: boolean,
  setByUserId: string
): Promise<void> {
  const definition = FEATURE_FLAGS[key]
  await db
    .insert(featureFlags)
    .values({
      key,
      state: definition.defaultState,
      rolloutUnit: definition.defaultRolloutUnit,
    })
    .onConflictDoNothing()
  await db
    .insert(tenantFeatureOverrides)
    .values({ tenantId, flagKey: key, enabled, setByUserId })
    .onConflictDoUpdate({
      target: [tenantFeatureOverrides.tenantId, tenantFeatureOverrides.flagKey],
      set: { enabled, setByUserId, updatedAt: new Date() },
    })
}

/** Remove an override, so this tenant follows the platform state again. */
export async function clearTenantOverride(
  db: Database,
  key: FeatureName,
  tenantId: string
): Promise<void> {
  await db
    .delete(tenantFeatureOverrides)
    .where(
      and(eq(tenantFeatureOverrides.tenantId, tenantId), eq(tenantFeatureOverrides.flagKey, key))
    )
}
