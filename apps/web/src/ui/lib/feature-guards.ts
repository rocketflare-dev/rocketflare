/**
 * Client-side spelling of the feature flags (D30). One const per feature so the nav, the routes and
 * the settings tabs cannot drift apart or disagree with the server.
 *
 * These are COSMETIC, exactly like every other `NavGuard`: the answer comes from `session.features`,
 * which the server resolved, and the server gates the same surfaces itself (`middleware/feature.ts`,
 * `cubesFor`, `listTemplates`). Hiding a link is never the protection — it is what stops a reader
 * clicking into a 404. Note the gated code still ships in the browser bundle; only the server keeps
 * an unreleased surface's DATA out of reach.
 */
import type { NavGuard } from '@/ui/hooks/useNavGuard'

/**
 * The kit's demonstration flag. Gates one nav item and nothing else — delete it, and its line in
 * `FEATURES`, when you add your own.
 *
 * `{ feature }`, not `{ action: 'access', subject: 'Feature:example-feature' }`: a global admin's
 * `manage all` satisfies the CASL form, which would show them a nav item whose routes the server
 * 404s. The flag is configuration; only `session.features` answers it.
 */
export const EXAMPLE_FEATURE: NavGuard = { feature: 'example-feature' }

/** `featureGuard(EXAMPLE_FEATURE, { action: 'read', subject: 'Thing' })` → the flag AND the permission. */
export const featureGuard = (feature: NavGuard, guard: NavGuard): NavGuard => [feature, guard]
