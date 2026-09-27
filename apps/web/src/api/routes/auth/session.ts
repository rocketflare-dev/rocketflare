/**
 * `/auth/methods`, `/auth/session`, `/auth/select-tenant`, `/auth/logout` (D9, D11, D25). NOT behind
 * `authMiddleware`: `/auth/session` must answer 200 for a valid cookie with NO tenant so the UI can
 * route to /select-tenant or /pending. Cookie only — Bearer keys are an `/api/*` credential.
 */
import type { AuthMethods, LogoutResponse } from '@rocketflare/shared/auth'
import { selectTenantRequestSchema } from '@rocketflare/shared/auth'
import { and, eq } from 'drizzle-orm'
import { hasOidc, isOidcOnly } from '../../../config'
import { tenantUsers } from '../../../db/schema'
import { clearSessionCookie } from '../../auth/cookies'
import { configuredProviders, oidcEndSessionUrl } from '../../auth/providers'
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
  // Only when an issuer is configured, so a deployment without OIDC answers exactly as before.
  if (hasOidc(cfg)) {
    methods.oidc = { label: cfg.OIDC_LABEL }
    methods.oidcOnly = isOidcOnly(cfg)
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

/**
 * 204, or — when an OIDC issuer is configured and advertises an `end_session_endpoint` — 200
 * `{ endSessionUrl }` so the browser ends the issuer's session too (otherwise an OIDC-only login
 * page would sign the user straight back in). The local session is gone either way.
 */
sessionRouter.post('/logout', async c => {
  const cfg = c.get('config')
  const auth = await resolveCookieAuth(c).catch(() => null)
  if (auth) await deleteSession(c.get('db'), auth.session.id)
  clearSessionCookie(c)
  if (hasOidc(cfg)) {
    const endSessionUrl = await oidcEndSessionUrl(cfg).catch(err => {
      c.get('logger').warn({ err }, 'OIDC discovery failed during logout; local logout only')
      return null
    })
    if (endSessionUrl) return c.json({ endSessionUrl } satisfies LogoutResponse)
  }
  return c.body(null, 204)
})
