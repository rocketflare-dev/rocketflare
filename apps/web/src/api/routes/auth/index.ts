/**
 * `/auth` mount (D11, D14): static routes first, the generic `/:provider` router LAST so
 * `/auth/session` is never mistaken for a provider. Rate limits (`authRateLimit`, 10/min/IP) sit
 * here on the login-shaped routes — never inside a handler.
 */
import { authRateLimit } from '../../middleware/rate-limit'
import { createRouter } from '../../utils/routes/router'
import { cliAuthRouter } from './cli'
import { devLoginRouter } from './dev-login'
import { magicLinkRouter } from './magic-link'
import { oauthRouter } from './oauth'
import { providerManagementRouter } from './providers'
import { sessionRouter } from './session'

export const authRouter = createRouter()

authRouter.use('/magic-link/request', authRateLimit)
authRouter.use('/dev-login', authRateLimit)

authRouter.route('/', sessionRouter)
authRouter.route('/magic-link', magicLinkRouter)
authRouter.route('/', devLoginRouter)
authRouter.route('/', providerManagementRouter)
authRouter.route('/', cliAuthRouter)

// OAuth start is rate-limited; the callback is not (the provider drives it).
authRouter.use('/:provider', async (c, next) => {
  if (c.req.method === 'GET') return authRateLimit(c, next)
  return next()
})
authRouter.route('/', oauthRouter)
