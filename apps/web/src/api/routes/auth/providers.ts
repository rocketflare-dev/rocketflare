/**
 * Linked OAuth identities for the signed-in user (D11): `GET /auth/providers`,
 * `DELETE /auth/providers/:provider`. Cookie session required. Linking happens through
 * `GET /auth/:provider?link=1` (oauth.ts).
 */

import { listProviderLinks, unlinkProvider } from '../../auth/oauth-providers'
import { getProvider } from '../../auth/providers'
import { resolveCookieAuth } from '../../middleware/auth'
import { NotFoundError, UnauthorizedError } from '../../utils/core/errors'
import { createRouter } from '../../utils/routes/router'

export const providerManagementRouter = createRouter()

providerManagementRouter.get('/providers', async c => {
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Not signed in')
  return c.json({ providers: await listProviderLinks(c.get('db'), auth.user.id) })
})

providerManagementRouter.delete('/providers/:provider', async c => {
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Not signed in')
  const def = getProvider(c.req.param('provider'))
  if (!def) throw new NotFoundError('Unknown provider')
  const removed = await unlinkProvider(c.get('db'), auth.user.id, def.id)
  if (!removed) throw new NotFoundError('Provider is not linked')
  return c.body(null, 204)
})
