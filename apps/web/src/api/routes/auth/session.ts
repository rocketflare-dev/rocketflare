/**
 * `/auth/methods`, `/auth/session`, `/auth/select-tenant`, `/auth/logout` (D9, D11, D25). NOT behind
 * `authMiddleware`: `/auth/session` must answer 200 for a valid cookie with NO tenant so the UI can
 * route to /select-tenant or /pending. Cookie only — Bearer keys are an `/api/*` credential.
 */
import type { AuthMethods } from '@gmgo/shared/auth'
import { selectTenantRequestSchema } from '@gmgo/shared/auth'
import { and, eq } from 'drizzle-orm'
import { tenantUsers } from '../../../db/schema'
import { clearSessionCookie } from '../../auth/cookies'
import { configuredProviders } from '../../auth/providers'
import { deleteSession, updateSelectedTenant } from '../../auth/sessions'
import { resolveCookieAuth } from '../../middleware/auth'
import { buildSessionResponse } from '../../services/auth'
import type { AppContext } from '../../types'
import { ForbiddenError, UnauthorizedError } from '../../utils/core/errors'
import { requireMultiTenant } from '../../utils/routes/route-helpers'
import { createRouter } from '../../utils/routes/router'
import { validate } from '../../utils/routes/validate'

export const sessionRouter = createRouter()

sessionRouter.get('/methods', c => {
  const cfg = c.get('config')
  const methods: AuthMethods = {
    magicLink: true,
    providers: configuredProviders(cfg),
    devLogin: cfg.APP_ENV === 'development',
  }
  return c.json(methods)
})

async function requireCookieAuth(c: AppContext) {
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Not signed in')
  return auth
}

sessionRouter.get('/session', async c => {
  const auth = await requireCookieAuth(c)
  return c.json(await buildSessionResponse(c.get('db'), c.get('config'), auth))
})

sessionRouter.post('/select-tenant', validate('json', selectTenantRequestSchema), async c => {
  const cfg = c.get('config')
  requireMultiTenant(cfg)
  const auth = await requireCookieAuth(c)
  const db = c.get('db')
  const { tenantId } = c.req.valid('json')
  const membership = await db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, auth.user.id)),
  })
  if (!membership) throw new ForbiddenError('You are not a member of that organisation')
  await updateSelectedTenant(db, auth.session.id, tenantId)
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError('Not signed in')
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})

sessionRouter.post('/logout', async c => {
  const auth = await resolveCookieAuth(c).catch(() => null)
  if (auth) await deleteSession(c.get('db'), auth.session.id)
  clearSessionCookie(c)
  return c.body(null, 204)
})
