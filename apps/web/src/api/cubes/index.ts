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

export { extractSecurityContext, tenantIdOf } from './security'
export { activityEventsCube, tenantActivityDailyCube, tenantUsersCube, usersCube }
