/**
 * `/api/features` (D30) — what this tenant actually has.
 *
 *   GET /    any member
 *
 * The read-only companion to `/api/admin/feature-flags`. It exists for two callers: the CLI, which
 * authenticates with a tenant API key and so cannot reach `/api/admin/*` at all
 * (`globalAdminMiddleware` resolves the cookie only), and anyone debugging "is this on for us?"
 * without a browser.
 *
 * It answers from `auth.features`, already resolved by the auth middleware, so it costs no query
 * and cannot disagree with the gate on any other route.
 */
import { FEATURE_FLAGS, FEATURE_KEYS } from '@rocketflare/shared/features'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const featuresRouter = createRouter()

featuresRouter.get('/', c => {
  const { auth } = withAuth(c)
  const features = auth.features
  return c.json({
    features,
    items: FEATURE_KEYS.map(key => ({
      key,
      label: FEATURE_FLAGS[key].label,
      enabled: features.includes(key),
    })),
  })
})
