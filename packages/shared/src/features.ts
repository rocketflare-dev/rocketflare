/**
 * Feature flags (D30) — the registry, the contracts, and the ONE implementation of "is this
 * feature on for this request".
 *
 * Two layers, in this order, because they answer two different questions:
 *
 *   1. ENVIRONMENT — does this surface exist in this deployment at all? A `[vars]` decision
 *      (`FEATURES_ENABLED`), fail-closed, no database. This is what lets half-built code be
 *      released to production dark, and it is settled before any row is read.
 *   2. ROLLOUT — among deployments where it exists, which tenants (or users) have it yet? A
 *      database decision a global admin drives from `/admin`: on, off, or a percentage.
 *
 * The composition is total and is written once, in `evaluateFlag`:
 *
 *   environmentGated && key not in FEATURES_ENABLED  -> false          (layer 1 wins outright)
 *   a tenant override row exists                     -> override.enabled
 *   state 'on' / 'off'                               -> true / false
 *   state 'rollout'                                  -> bucket(key, unitId) < rolloutPercent
 *   no row at all                                    -> the registry default
 *
 * The override beats the rollout because that is what it is FOR: the design-partner allow-list and
 * the "this customer must never get it" block-list. Its `enabled` column is the decision and the
 * row's presence is merely the exception — the same "a column, not the presence of rows" rule that
 * `visibility` follows in the schema helpers.
 *
 * **A flag is configuration, not a permission.** Nothing here touches CASL, and no gate may ask the
 * ability: `manage all` and `access all` are wildcards that cover every `Feature:` subject, so an
 * ability check hands platform staff a surface the deployment does not ship. See `permissions.ts`.
 */
import { z } from 'zod'
import { FEATURES, type FeatureName } from './permissions'

/** Platform state of a flag. `off` and `rollout` at 0% are the same OUTCOME, not the same intent. */
export const FEATURE_FLAG_STATES = ['off', 'on', 'rollout'] as const
export const featureFlagStateSchema = z.enum(FEATURE_FLAG_STATES)
export type FeatureFlagState = z.infer<typeof featureFlagStateSchema>

/** What a percentage rollout counts. `tenant` keeps a workspace internally consistent. */
export const FEATURE_ROLLOUT_UNITS = ['tenant', 'user'] as const
export const featureRolloutUnitSchema = z.enum(FEATURE_ROLLOUT_UNITS)
export type FeatureRolloutUnit = z.infer<typeof featureRolloutUnitSchema>

export const featureNameSchema = z.enum(FEATURES)

export interface FeatureDefinition {
  /** Shown in `/admin`; the key is what code uses. */
  label: string
  description: string
  /** Applied when no row exists yet — a flag needs no row to be evaluated. */
  defaultState: FeatureFlagState
  defaultRolloutUnit: FeatureRolloutUnit
  /**
   * The surface ships DARK unless this deployment lists the key in `FEATURES_ENABLED`. Set it for
   * anything half-built: the failure mode of forgetting the var is then an absent surface, not an
   * unreleased one in production. Leave it false for an ordinary rollout flag, which then needs no
   * toml edit at all.
   */
  environmentGated: boolean
}

/**
 * Every flag this app ships. Keys come from `FEATURES` in `permissions.ts`, so a typo anywhere that
 * gates on one is a type error rather than a route that 404s for ever.
 *
 * `example-feature` is the kit's inert demonstration — it gates one nav item and nothing else.
 * Delete its line here and in `FEATURES` when you add your own.
 */
export const FEATURE_FLAGS: Record<FeatureName, FeatureDefinition> = {
  'example-feature': {
    label: 'Example feature',
    description:
      'The kit’s demonstration flag. Gates one nav item so the whole path — environment, rollout, ' +
      'override, session, nav — can be seen working. Safe to delete.',
    defaultState: 'off',
    defaultRolloutUnit: 'tenant',
    environmentGated: false,
  },
}

export const FEATURE_KEYS = Object.keys(FEATURE_FLAGS) as FeatureName[]

export function isFeatureName(value: string): value is FeatureName {
  return Object.hasOwn(FEATURE_FLAGS, value)
}

// ---- The bucket ---------------------------------------------------------------------------------

/**
 * FNV-1a 32-bit over `"<key>:<unitId>"`, reduced to 0..99.
 *
 * **This is a wire format.** Changing the hash, the separator or the modulus reshuffles every live
 * rollout — tenants already inside one would fall out of it. Treat it as frozen;
 * `tests/config/features.test.ts` pins golden vectors for exactly that reason.
 *
 * Three properties the rest of the design leans on:
 *
 *   - MONOTONIC. The bucket depends only on `(key, unitId)` — never on the percentage — and the
 *     test is `bucket < rolloutPercent`. So raising the percentage only ever ADDS units; nobody is
 *     ever dropped from a rollout that grows. This is the whole reason the percentage is not part
 *     of the hashed string, and why it must never be.
 *   - INDEPENDENT ACROSS FLAGS. `key` is in the string, so flag A's 10% cohort is uncorrelated with
 *     flag B's. Hashing the unit id alone would inflict every early rollout on the same unlucky few.
 *   - The modulo bias is real and negligible: 2^32 % 100 = 96, so buckets 0..95 are favoured by
 *     ~2.3e-8 relative. Not worth "fixing" — a different hash would silently reshuffle production.
 */
export function featureBucket(key: string, unitId: string): number {
  let hash = 0x811c9dc5
  const input = `${key}:${unitId}`
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // `Math.imul` keeps the 32-bit multiply exact; `>>> 0` returns it to unsigned each round.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}

// ---- Evaluation ---------------------------------------------------------------------------------

/** One flag's stored state as the auth path reads it: the platform row plus this tenant's override. */
export const featureFlagEvaluationSchema = z.object({
  key: featureNameSchema,
  state: featureFlagStateSchema,
  rolloutPercent: z.number().int().min(0).max(100),
  rolloutUnit: featureRolloutUnitSchema,
  /** `null` = no override row; the platform state decides. */
  override: z.boolean().nullable(),
})
export type FeatureFlagEvaluation = z.infer<typeof featureFlagEvaluationSchema>

/** Who is asking. Either id may be absent — a session with no membership, or an unauthenticated read. */
export interface FeatureEvaluationContext {
  tenantId: string | null
  userId: string | null
  /** Keys this deployment permits at all (`FEATURES_ENABLED`). Only consulted for gated flags. */
  environmentEnabled: readonly string[]
}

/** The unit a percentage rollout counts; `null` means the rollout cannot apply and answers false. */
function unitIdFor(unit: FeatureRolloutUnit, ctx: FeatureEvaluationContext): string | null {
  return unit === 'user' ? ctx.userId : ctx.tenantId
}

/**
 * Is `key` on for this request? `row` is the stored state, or `null` when nothing has been saved.
 * Every branch fails closed, so an unknown or half-configured flag is off rather than exposed.
 */
export function evaluateFlag(
  key: FeatureName,
  row: FeatureFlagEvaluation | null,
  ctx: FeatureEvaluationContext
): boolean {
  const definition = FEATURE_FLAGS[key]
  if (!definition) return false
  // Layer 1. An environment that has not opted in never reaches the database state at all.
  if (definition.environmentGated && !ctx.environmentEnabled.includes(key)) return false
  // Layer 2.
  if (!row) return definition.defaultState === 'on'
  if (row.override !== null) return row.override
  if (row.state === 'on') return true
  if (row.state === 'off') return false
  const unitId = unitIdFor(row.rolloutUnit, ctx)
  if (!unitId) return false
  return featureBucket(key, unitId) < row.rolloutPercent
}

/** Every feature on for this request, in `FEATURE_KEYS` order so tests can compare arrays. */
export function evaluateFeatures(
  rows: readonly FeatureFlagEvaluation[],
  ctx: FeatureEvaluationContext
): FeatureName[] {
  const byKey = new Map(rows.map(row => [row.key, row]))
  return FEATURE_KEYS.filter(key => evaluateFlag(key, byKey.get(key) ?? null, ctx))
}

// ---- API contracts ------------------------------------------------------------------------------

/** One flag as `/admin` sees it: the registry, the stored state, and how many tenants override it. */
export const featureFlagSchema = z.object({
  key: featureNameSchema,
  label: z.string(),
  description: z.string(),
  state: featureFlagStateSchema,
  rolloutPercent: z.number().int().min(0).max(100),
  rolloutUnit: featureRolloutUnitSchema,
  environmentGated: z.boolean(),
  /** False when `environmentGated` and this deployment does not list the key — off for everyone. */
  availableInEnvironment: z.boolean(),
  overrideCount: z.number().int().min(0),
  updatedAt: z.coerce.date().nullable(),
})
export type FeatureFlag = z.infer<typeof featureFlagSchema>

export const featureFlagListResponseSchema = z.object({ items: z.array(featureFlagSchema) })
export type FeatureFlagListResponse = z.infer<typeof featureFlagListResponseSchema>

export const updateFeatureFlagRequestSchema = z
  .object({
    state: featureFlagStateSchema,
    rolloutPercent: z.number().int().min(0).max(100),
    rolloutUnit: featureRolloutUnitSchema,
  })
  .partial()
  .refine(body => Object.keys(body).length > 0, { message: 'Nothing to update' })
export type UpdateFeatureFlagRequest = z.infer<typeof updateFeatureFlagRequestSchema>

export const tenantFeatureOverrideSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  flagKey: featureNameSchema,
  enabled: z.boolean(),
  updatedAt: z.coerce.date(),
})
export type TenantFeatureOverride = z.infer<typeof tenantFeatureOverrideSchema>

export const tenantFeatureOverrideListResponseSchema = z.object({
  items: z.array(tenantFeatureOverrideSchema),
})
export type TenantFeatureOverrideListResponse = z.infer<
  typeof tenantFeatureOverrideListResponseSchema
>

export const setTenantOverrideRequestSchema = z.object({ enabled: z.boolean() })
export type SetTenantOverrideRequest = z.infer<typeof setTenantOverrideRequestSchema>

/** `GET /api/features` — what the active tenant actually has, for the CLI and for debugging. */
export const effectiveFeatureSchema = z.object({
  key: featureNameSchema,
  label: z.string(),
  enabled: z.boolean(),
})
export type EffectiveFeature = z.infer<typeof effectiveFeatureSchema>

export const effectiveFeaturesResponseSchema = z.object({
  features: z.array(featureNameSchema),
  items: z.array(effectiveFeatureSchema),
})
export type EffectiveFeaturesResponse = z.infer<typeof effectiveFeaturesResponseSchema>
