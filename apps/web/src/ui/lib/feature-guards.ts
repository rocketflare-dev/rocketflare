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
 * One const per feature, spelled `{ feature }` and never `{ action: 'access', subject: 'Feature:x' }`:
 * a global admin's `manage all` satisfies the CASL form, which would show them a nav item whose
 * routes the server 404s. The flag is configuration; only `session.features` answers it.
 *
 * The kit ships none of its own — its demonstration flag lives in the `example-feature` PLUGIN
 * (D31), which declares its guard beside the route and the nav item it gates, in
 * `apps/web/src/plugins/example-feature/ui/index.ts`. A plugin never edits this file.
 */

/** `featureGuard(MY_FEATURE, { action: 'read', subject: 'Thing' })` → the flag AND the permission. */
export const featureGuard = (feature: NavGuard, guard: NavGuard): NavGuard => [feature, guard]
