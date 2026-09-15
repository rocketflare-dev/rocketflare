/**
 * Mount-level gate for a feature that ships dark (D30). Applied in `api/index.ts` beside
 * `authMiddleware` on every prefix the feature owns, so the gate is declared ONCE per surface
 * rather than remembered in each handler — the same reason auth is per-mount.
 *
 * It answers 404 `feature_disabled`, not 403: a reader probing a route on a deployment that ships
 * the feature dark should learn nothing except that there is no such route. A 403 would confirm the
 * feature exists, which is exactly what an unreleased surface must not do. That matches
 * `requireMultiTenant`'s 404 `tenancy_mode_single` for the same class of "configured away" surface.
 *
 * It reads `AuthContext.features` — the same array `cubesFor` and `listTemplates` read — so there is
 * exactly one answer to "is this feature on for this request", and never the CASL ability, whose
 * `manage all` would hand the dark surface to every global admin. See `permissions/features.ts`.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { FeatureName } from '@rocketflare/shared/permissions'
import { createMiddleware } from 'hono/factory'
import { hasFeature } from '../../permissions/features'
import type { AppEnv } from '../types'
import { NotFoundError } from '../utils/core/errors'

export function requireFeature(feature: FeatureName) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // The features ARRAY, never the ability: `manage all` satisfies a `Feature:` subject and would
    // hand every global admin the dark surface. See `permissions/features.ts`.
    if (!hasFeature(c.get('auth')?.features ?? [], feature)) {
      throw new NotFoundError(
        `Not found: ${new URL(c.req.url).pathname}`,
        ERROR_CODES.featureDisabled
      )
    }
    await next()
  })
}
