/**
 * Where a feature flag comes from (D30). The kit shipped `AbilityContext.features` as a live seam
 * with no source — `middleware/auth.ts` passed `[]` — and `docs/CONCEPTS.md` §1 recorded
 * "feature-flag source for `access` is undecided" as a known gap. This file is that decision.
 *
 * There are two sources, and they answer different questions:
 *
 *   1. `[vars]` (`FEATURES_ENABLED`) — does this surface exist in this deployment at all? Config,
 *      because a surface that ships dark has to be dark on the FIRST request of a new deploy,
 *      before any row exists, and config is the only source with no bootstrap problem.
 *   2. `feature_flags` + `tenant_feature_overrides` — among deployments where it exists, which
 *      tenants have it yet? A global admin drives that from `/admin` with no redeploy.
 *
 * `resolveFeatures` is the ONE place they combine, and every consumer downstream — `requireFeature`,
 * `cubesFor`, `listTemplates`, the nav — reads the array it returns. A third source (a per-plan
 * entitlement, say) would be unioned in here and nothing else would change.
 */
import { evaluateFeatures, type FeatureFlagEvaluation } from '@rocketflare/shared/features'
import type { FeatureName } from '@rocketflare/shared/permissions'
import type { AppConfig } from '../config'

/**
 * **A feature flag is configuration, not a permission, and is deliberately NOT read through CASL.**
 *
 * `globalAdmin` is `can('manage', 'all')` and `support` is granted `access all`; in CASL `manage`
 * and `all` are wildcards covering every action on every subject — including `access` on
 * `Feature:<name>`. An ability check therefore answers "on" for platform staff whatever the
 * deployment ships, while `cubesFor` and `listTemplates`, which read this array, answer "off". Two
 * sources of truth, disagreeing, in the one design that set out to have exactly one — and the
 * disagreement hands unreleased surfaces to staff in production.
 *
 * Hence: every gate reads `AuthContext.features` (server) or `SessionResponse.features` (browser).
 * `applyFeatureFlags` still puts `Feature:<name>` in the ability for an app that genuinely wants
 * permission-style entitlements, but nothing that hides a dark surface may depend on it.
 */
export function hasFeature(features: readonly string[], name: FeatureName): boolean {
  return features.includes(name)
}

/** Who the flags are being resolved for. Either id may be absent (a session with no membership). */
export interface FeatureSubjectContext {
  tenantId: string | null
  userId: string | null
}

/**
 * The features this request may use. `rows` is the stored rollout state for the active tenant, as
 * the auth path read it; an empty array is correct rather than an error — a flag with no row falls
 * back to its registry default, so a fresh database is simply every flag at its default.
 *
 * Order is stable (`FEATURE_KEYS`) so tests can compare arrays.
 */
export function resolveFeatures(
  cfg: AppConfig,
  rows: readonly FeatureFlagEvaluation[],
  subject: FeatureSubjectContext
): FeatureName[] {
  // No organisation, no answer. Every gated surface is tenant-scoped, so a session that has not
  // chosen one has nothing a feature could be on FOR — and this keeps "no membership means no
  // permissions" literally true, which `auth-session` asserts on the packed rules.
  if (!subject.tenantId) return []
  return evaluateFeatures(rows, {
    tenantId: subject.tenantId,
    userId: subject.userId,
    environmentEnabled: cfg.FEATURES_ENABLED,
  })
}
