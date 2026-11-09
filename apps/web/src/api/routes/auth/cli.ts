/**
 * The browser side of CLI login. `redirect_uri` MUST be a loopback
 * `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` — that allowlist is what
 * makes handing the key over in a query string acceptable.
 *
 * `GET /auth/cli` never creates anything: no session → the login page with a `returnUrl` back here;
 * session but no tenant → `/select-tenant`; otherwise a 302 to the SPA's `/cli/confirm`, where the
 * person sees what is about to happen. `POST /auth/cli/confirm` (JSON, cookie session, so the CSRF
 * middleware applies) mints a tenant API key named `cli:<hostname>` (scopes `['*']`, via the same
 * helper `POST /api/keys` uses) and answers the loopback URL `?key=&tenant_id=&tenant_name=&state=`
 * for the page to navigate to: the `form-action 'self'` CSP rules out a native form redirecting
 * to loopback. `state` is the CLI's own per-login value, passed through untouched. The key is
 * never logged.
 */
import { type CliConfirmResponse, cliConfirmRequestSchema } from '@rocketflare/shared/auth'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { mintApiKey } from '../../auth/api-keys'
import { resolveCookieAuth } from '../../middleware/auth'
import { recordActivity } from '../../services/activity'
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../../utils/core/errors'
import { makeDefer } from '../../utils/routes/route-helpers'
import { createRouter } from '../../utils/routes/router'
import { validate } from '../../utils/routes/validate'

export const cliAuthRouter = createRouter()

/** `http://127.0.0.1:<port>/callback` | `http://localhost:<port>/callback`, nothing else. */
export function validateCliRedirectUri(value: string | undefined): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  if (url.pathname !== '/callback') return null
  if (url.search || url.hash || url.username || url.password) return null
  return url
}

function keyName(hostname: string | undefined): string {
  const clean = (hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
  return `cli:${clean || 'cli'}`
}

const INVALID_REDIRECT = [
  'redirect_uri must be http://127.0.0.1:<port>/callback or http://localhost:<port>/callback',
  'invalid_redirect_uri',
] as const

cliAuthRouter.get('/cli', async c => {
  const redirectUri = validateCliRedirectUri(c.req.query('redirect_uri'))
  if (!redirectUri) throw new BadRequestError(...INVALID_REDIRECT)
  const params = new URLSearchParams({ redirect_uri: redirectUri.toString() })
  for (const name of ['hostname', 'state']) {
    const value = c.req.query(name)
    if (value) params.set(name, value)
  }
  const returnUrl = `/auth/cli?${params}`
  const auth = await resolveCookieAuth(c)
  if (!auth) return c.redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  if (!auth.tenantId || !auth.tenant) {
    return c.redirect(`/select-tenant?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  }
  return c.redirect(`/cli/confirm?${params}`, 302)
})

cliAuthRouter.post('/cli/confirm', validate('json', cliConfirmRequestSchema), async c => {
  const { redirectUri, hostname, state } = c.req.valid('json')
  const target = validateCliRedirectUri(redirectUri)
  if (!target) throw new BadRequestError(...INVALID_REDIRECT)
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  if (!auth.tenantId || !auth.tenant) {
    throw new ForbiddenError('No organisation selected', ERROR_CODES.noTenant)
  }

  const db = c.get('db')
  const { row, plaintext } = await mintApiKey(db, {
    tenantId: auth.tenantId,
    createdByUserId: auth.user.id,
    name: keyName(hostname),
    scopes: ['*'],
  })
  makeDefer(c)(() =>
    recordActivity(db, {
      tenantId: row.tenantId,
      userId: auth.user.id,
      type: 'api_key.created',
      subjectType: 'ApiKey',
      subjectId: row.id,
      metadata: { name: row.name, via: 'cli' },
    })
  )

  target.searchParams.set('key', plaintext)
  target.searchParams.set('tenant_id', auth.tenantId)
  target.searchParams.set('tenant_name', auth.tenant.name)
  if (state) target.searchParams.set('state', state)
  return c.json({ redirectTo: target.toString() } satisfies CliConfirmResponse)
})
