/**
 * Cube registry (D19): `allCubes` is what `routes/cube-api.ts` hands to `createCubeApp` on every
 * request and what `tests/api/cubes/cube-isolation.test.ts` walks. Adding a cube = a file here +
 * an entry below + the isolation test's seed for its table. Read ./CLAUDE.md first.
 */
import type { Cube } from 'drizzle-cube/server'
import { activityEventsCube } from './activity-events'
import { tenantActivityDailyCube } from './tenant-activity-daily'
import { tenantUsersCube } from './tenant-users'
import { usersCube } from './users'

/** Sorted by title, which is the order the schema explorer shows. */
export const allCubes: Cube[] = [
  activityEventsCube, // Activity Events
  tenantActivityDailyCube, // Daily Activity
  tenantUsersCube, // Members
  usersCube, // Users
]

/**
 * Cubes belonging to a feature that ships dark (D30). `allCubes` stays the FULL registry — the
 * isolation test walks it and its coverage assertion must still see every cube, because a cube's
 * tenant scoping has to be proven whether or not its feature is on today — so the filtering happens
 * per request in `routes/cube-api.ts` instead.
 *
 * The kit ships none. An app gating, say, a CRM adds `crm: [companiesCube, dealsCube]`.
 */
const FEATURE_CUBES: Record<string, readonly Cube[]> = {}

/**
 * The cubes this request may compile against. A cube whose feature is off is absent from
 * `/cubejs-api/v1/meta` and from `/mcp`, so a dark feature is not discoverable through the analytics
 * surface either — the gate has to cover every door, not just the nav.
 */
export function cubesFor(features: readonly string[]): Cube[] {
  const hidden = new Set<Cube>()
  for (const [feature, cubes] of Object.entries(FEATURE_CUBES)) {
    if (!features.includes(feature)) for (const cube of cubes) hidden.add(cube)
  }
  return hidden.size === 0 ? allCubes : allCubes.filter(cube => !hidden.has(cube))
}

export { extractSecurityContext, tenantIdOf } from './security'
export { activityEventsCube, tenantActivityDailyCube, tenantUsersCube, usersCube }
