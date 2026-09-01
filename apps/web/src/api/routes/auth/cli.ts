/**
 * `GET /auth/cli?redirect_uri=` (D26): the browser-based CLI login. `redirect_uri` MUST be a
 * loopback `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` — that
 * allowlist is what makes handing the key over in a query string acceptable. No session → the
 * login page with a `returnUrl` back here; session but no tenant → `/select-tenant`; otherwise
 * mint a tenant API key named `cli:<hostname>` (scopes `['*']`, via the same helper `POST /api/keys`
 * uses) and 302 to `redirect_uri?key=&tenant_id=&tenant_name=`. The key is never logged.
 */
import { mintApiKey } from '../../auth/api-keys'
import { resolveCookieAuth } from '../../middleware/auth'
import { recordActivity } from '../../services/activity'
import { BadRequestError } from '../../utils/core/errors'
import { makeDefer } from '../../utils/routes/route-helpers'
import { createRouter } from '../../utils/routes/router'

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

cliAuthRouter.get('/cli', async c => {
  const redirectUri = validateCliRedirectUri(c.req.query('redirect_uri'))
  if (!redirectUri) {
    throw new BadRequestError(
      'redirect_uri must be http://127.0.0.1:<port>/callback or http://localhost:<port>/callback',
      'invalid_redirect_uri'
    )
  }
  const returnUrl = `/auth/cli?redirect_uri=${encodeURIComponent(redirectUri.toString())}`
  const auth = await resolveCookieAuth(c)
  if (!auth) return c.redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  if (!auth.tenantId || !auth.tenant) {
    return c.redirect(`/select-tenant?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  }

  const db = c.get('db')
  const { row, plaintext } = await mintApiKey(db, {
    tenantId: auth.tenantId,
    createdByUserId: auth.user.id,
    name: keyName(c.req.query('hostname')),
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

  const target = new URL(redirectUri.toString())
  target.searchParams.set('key', plaintext)
  target.searchParams.set('tenant_id', auth.tenantId)
  target.searchParams.set('tenant_name', auth.tenant.name)
  return c.redirect(target.toString(), 302)
})
