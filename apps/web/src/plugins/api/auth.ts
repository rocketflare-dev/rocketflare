/**
 * Who is asking, and what they may do (D10, D29, D30, D31).
 *
 * Three different questions live here and the kit keeps them apart on purpose. Conflating any two
 * of them is the bug this file exists to make hard:
 *
 * 1. **May this ROLE do this KIND of thing?** — `guard` / `can`, over CASL. A plugin declares its
 *    subject in `SharedPlugin.subjects` and grants it in `ServerPlugin.grants`.
 * 2. **Is this ROW theirs?** — never CASL. It is the route's own `ownerUserId` check, or a SQL
 *    predicate (`./access.ts`). The kit uses no CASL conditions anywhere.
 * 3. **Does this deployment SHIP this surface?** — a feature flag, and it is configuration rather
 *    than a permission. `hasFeature(...)`, never `can('access', 'Feature:x')`: `globalAdmin` is
 *    `manage all`, which in CASL covers `access` on every `Feature:` subject, so the ability form
 *    answers "on" for platform staff whatever the deployment ships. That disagreement — an ability
 *    saying yes while the array said no — is a real incident, recorded in `docs/CONCEPTS.md` §15.
 */

import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { requireFeature } from '../../api/middleware/feature'
import { isAdminLevel, isGlobalAdmin, isOwnerLevel } from '../../api/middleware/permissions'
import type { User } from '../../db/schema'

export type { Actions, Subjects } from '@rocketflare/shared/permissions'
export type { MembershipRole } from '@rocketflare/shared/tenants'
export type { User } from '../../db/schema'
/**
 * The gate a plugin puts on its MOUNT, never on each route (D30).
 *
 * One middleware beneath the whole prefix means a surface that ships dark is dark as a whole,
 * declared once like auth. It answers **404 `feature_disabled`, not 403**: a 403 confirms the
 * feature exists, which is exactly what an unreleased surface must not do.
 */
/**
 * Role predicates, for the handful of decisions CASL deliberately does not express.
 *
 * `isOwnerLevel` is the one to reach for when an action is irreversible (deleting the tenant,
 * transferring ownership): `manage Tenant` is held by `support` and by every global admin, so it is
 * the wrong question. `isAdminLevel` is the same set that bypasses row visibility.
 */
export { isAdminLevel, isGlobalAdmin, isOwnerLevel, requireFeature }

/**
 * Who is asking, flattened — the half of the auth context a plugin has any business reading.
 *
 * Deliberately NOT the kit's `AuthContext`: that carries `ability`, `session` and
 * `accessRequestStatus`, none of which a plugin should be reasoning about, and all of which are
 * things the kit wants to be free to change. What is here is what the measurement found plugins
 * actually using.
 */
export interface PluginAuth {
  user: User
  userId: string
  /** The active organisation — the ONLY tenant id a query may filter by. */
  tenantId: string
  role: MembershipRole | null
  isAdmin: boolean
  isOwner: boolean
  isGlobalAdmin: boolean
  /** Flags on for this organisation. Read with `hasFeature`, never through the ability. */
  features: readonly string[]
}

/** `true` when this deployment ships the surface AND this organisation has it yet. */
export function hasFeature(auth: Pick<PluginAuth, 'features'>, name: string): boolean {
  return auth.features.includes(name)
}

/** The two-argument ability check, as a plugin's own helper takes it. */
export type AbilityCheck = (action: Actions, subject: Subjects) => boolean
