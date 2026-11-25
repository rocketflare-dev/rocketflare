/**
 * The authorization server's HTTP surface — thin; every rule is in `services/mcp/authorization.ts`.
 *
 * `/oauth` (all behind the deployment gate: 404 unless the deployment ships `mcp`):
 * - `GET /authorize` — validate the client and the request; no session → the app's `/login` with a
 *   `returnUrl` back to `/oauth/continue`; with one → `/oauth/continue` at once.
 * - `GET /continue?request=` — a remembered consent goes straight back to the client with a code;
 *   otherwise the SPA's consent page, `/consent?request=<id>`.
 * - `GET /consent/:request` — what the consent page shows (cookie session).
 * - `POST /consent` — the decision (JSON, cookie session, so the CSRF middleware applies).
 * - `POST /token`, `POST /revoke` — form-encoded, public clients, any origin, no cookies.
 *
 * `/.well-known` (`wellKnownRouter`): RFC 9728 protected-resource metadata for `/mcp` and every
 * `/mcp/t/<slug>`, and RFC 8414 authorization-server metadata (also at `openid-configuration`,
 * which some clients try first).
 *
 * Rate limits: the browser steps (authorize, continue, consent) take `authRateLimit` like every
 * login-shaped route. The token and revoke endpoints are called from the hosted clients' own
 * servers — one IP for every person of every organisation using that client — so they get a
 * generous per-IP backstop and a per-connection limit instead.
 */
import { MCP_SCOPES } from '@rocketflare/shared/mcp'
import {
  type ConsentDecisionResponse,
  consentDecisionSchema,
  oauthRequestIdSchema,
} from '@rocketflare/shared/oauth'
import { cors } from 'hono/cors'
import { resolveCookieAuth } from '../middleware/auth'
import {
  authRateLimit,
  checkRateLimit,
  type RateLimitKv,
  rateLimit,
} from '../middleware/rate-limit'
import {
  consentDetails,
  decideConsent,
  exchangeCode,
  grantOfTokenRequest,
  OAuthError,
  oauthIssuer,
  pendingRequest,
  refreshTokens,
  rememberedConsent,
  revokeToken,
  startAuthorization,
  type TokenAnswer,
} from '../services/mcp/authorization'
import { mcpResourceUrl } from '../services/mcp/tokens'
import type { AppContext } from '../types'
import { NotFoundError, UnauthorizedError } from '../utils/core/errors'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { mcpDeploymentGate } from './mcp'

export const oauthRouter = createRouter()
export const wellKnownRouter = createRouter()

/** The token-shaped endpoints and the documents: any origin, never credentials. */
const openCors = cors({
  origin: '*',
  credentials: false,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  maxAge: 600,
})

/** Per IP — the hosted clients share theirs, so it is a backstop, not the limit. */
const tokenIpLimit = rateLimit({ name: 'oauth-token', max: 600, windowSeconds: 60 })
export const TOKEN_CALLS_PER_GRANT_PER_MINUTE = 30

oauthRouter.use('*', mcpDeploymentGate)
oauthRouter.use('/token', openCors, tokenIpLimit)
oauthRouter.use('/revoke', openCors, tokenIpLimit)
oauthRouter.use('/authorize', authRateLimit)
oauthRouter.use('/continue', authRateLimit)
oauthRouter.use('/consent', authRateLimit)
oauthRouter.use('/consent/*', authRateLimit)

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch)

/**
 * The page an authorization error lands on when the client could not be trusted with a redirect.
 * The deployment's own name; no product name, no detail beyond the description.
 */
function errorPage(c: AppContext, description: string, status: 400 | 404 = 400) {
  const name = escapeHtml(c.get('config').APP_NAME)
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>` +
      '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
      '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">' +
      `<h1 style="font-size:1.25rem">Cannot connect to ${name}</h1>` +
      `<p>${escapeHtml(description)}</p>` +
      '<p>Close this tab and try connecting again from the app you started in.</p></body></html>',
    status
  )
}

/** Where the browser goes for a pending request once a person is signed in. */
async function continuePending(c: AppContext, requestId: string): Promise<Response> {
  const db = c.get('db')
  const cfg = c.get('config')
  const pending = await pendingRequest(db, requestId)
  if (!pending) {
    return errorPage(c, 'This connection request has expired or was already used.', 404)
  }
  const auth = await resolveCookieAuth(c)
  if (!auth) {
    const returnUrl = `/oauth/continue?request=${requestId}`
    return c.redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`, 302)
  }
  const remembered = await rememberedConsent(db, cfg, {
    userId: auth.user.id,
    request: pending.request,
  })
  if (remembered) return c.redirect(remembered, 302)
  return c.redirect(`/consent?request=${requestId}`, 302)
}

oauthRouter.get('/authorize', async c => {
  const outcome = await startAuthorization(c.get('db'), c.get('config'), c.req.query())
  if (outcome.kind === 'page') {
    if (outcome.reason) {
      c.get('logger').info(
        { clientId: c.req.query('client_id'), reason: outcome.reason },
        'oauth: client metadata document refused'
      )
    }
    return errorPage(c, outcome.description)
  }
  if (outcome.kind === 'redirect') return c.redirect(outcome.location, 302)
  return continuePending(c, outcome.request.id)
})

oauthRouter.get('/continue', async c => {
  const id = oauthRequestIdSchema.safeParse(c.req.query('request'))
  if (!id.success) return errorPage(c, 'This connection request is not valid.', 404)
  return continuePending(c, id.data)
})

/** A signed-in person (any tenant state) — the consent API's one requirement before the request. */
async function signedIn(c: AppContext) {
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  return auth
}

oauthRouter.get('/consent/:request', async c => {
  const id = oauthRequestIdSchema.safeParse(c.req.param('request'))
  if (!id.success) throw new NotFoundError('Connection request not found')
  const auth = await signedIn(c)
  const db = c.get('db')
  const pending = await pendingRequest(db, id.data)
  if (!pending) {
    throw new NotFoundError('This connection request has expired or was already used')
  }
  c.header('Cache-Control', 'no-store')
  return c.json(
    await consentDetails(db, c.get('config'), c.env, {
      userId: auth.user.id,
      request: pending.request,
      client: pending.client,
    })
  )
})

oauthRouter.post('/consent', validate('json', consentDecisionSchema), async c => {
  const body = c.req.valid('json')
  const auth = await signedIn(c)
  const db = c.get('db')
  const pending = await pendingRequest(db, body.requestId)
  if (!pending) {
    throw new NotFoundError('This connection request has expired or was already used')
  }
  try {
    const redirectTo = await decideConsent(db, c.get('config'), {
      userId: auth.user.id,
      request: pending.request,
      client: pending.client,
      approve: body.approve,
      tenantId: body.approve ? body.tenantId : undefined,
    })
    return c.json({ redirectTo } satisfies ConsentDecisionResponse)
  } catch (err) {
    if (err instanceof OAuthError) {
      return c.json(
        { error: err.description, statusCode: err.status, code: err.code },
        err.status as 400 | 403
      )
    }
    throw err
  }
})

/** The body of a form-encoded OAuth request, as strings (a repeated or file field is dropped). */
async function formOf(c: AppContext): Promise<Record<string, string | undefined> | null> {
  const type = (c.req.header('Content-Type') ?? '').toLowerCase()
  if (!type.startsWith('application/x-www-form-urlencoded')) return null
  const params = new URLSearchParams(await c.req.text())
  const out: Record<string, string | undefined> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    // RFC 6749 §3.1: a parameter sent twice is an error; treat it as absent so the check fails.
    out[key] = values.length === 1 ? values[0] : undefined
  }
  return out
}

/** RFC 6749 §5.2 — the OAuth error shape, which is also the kit's envelope. */
function oauthErrorResponse(c: AppContext, err: OAuthError) {
  c.header('Cache-Control', 'no-store')
  return c.json(
    {
      error: err.code,
      error_description: err.description,
      statusCode: err.status,
      code: err.code,
    },
    err.status as 400 | 401 | 403 | 429
  )
}

oauthRouter.post('/token', async c => {
  const form = await formOf(c)
  if (!form) {
    return oauthErrorResponse(
      c,
      new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded')
    )
  }
  const db = c.get('db')
  const cfg = c.get('config')
  const kv = c.env.RATE_LIMIT_KV as RateLimitKv | undefined
  if (kv) {
    const grantId = await grantOfTokenRequest(db, form)
    if (grantId) {
      const decision = await checkRateLimit(kv, `rl:oauth-token-grant:${grantId}`, {
        max: TOKEN_CALLS_PER_GRANT_PER_MINUTE,
        windowSeconds: 60,
      })
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        return oauthErrorResponse(
          c,
          new OAuthError('invalid_request', 'Too many token requests for this connection', 429)
        )
      }
    }
  }
  let answer: TokenAnswer
  try {
    if (form.grant_type === 'authorization_code') answer = await exchangeCode(db, cfg, form)
    else if (form.grant_type === 'refresh_token') answer = await refreshTokens(db, cfg, form)
    else {
      throw new OAuthError(
        'unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token'
      )
    }
  } catch (err) {
    if (err instanceof OAuthError) return oauthErrorResponse(c, err)
    throw err
  }
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  return c.json({
    access_token: answer.pair.accessToken,
    token_type: 'Bearer',
    expires_in: answer.pair.expiresIn,
    refresh_token: answer.pair.refreshToken,
    scope: answer.scopes.join(' '),
  })
})

oauthRouter.post('/revoke', async c => {
  const form = await formOf(c)
  if (!form) {
    return oauthErrorResponse(
      c,
      new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded')
    )
  }
  await revokeToken(c.get('db'), form)
  c.header('Cache-Control', 'no-store')
  return c.body(null, 200)
})

/** RFC 9728 — the resource is the exact URL the document was asked for. */
function protectedResource(c: AppContext, slug?: string) {
  const cfg = c.get('config')
  return c.json({
    resource: mcpResourceUrl(cfg, slug),
    authorization_servers: [oauthIssuer(cfg)],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: cfg.APP_NAME,
  })
}

// Each document is registered with its own CORS and gate rather than a `use('*')`: the router is
// mounted at `/.well-known`, and a wildcard there would answer for every other document too.
wellKnownRouter.on(
  ['GET', 'OPTIONS'],
  '/oauth-protected-resource',
  openCors,
  mcpDeploymentGate,
  c => protectedResource(c)
)
wellKnownRouter.on(
  ['GET', 'OPTIONS'],
  '/oauth-protected-resource/mcp',
  openCors,
  mcpDeploymentGate,
  c => protectedResource(c)
)
wellKnownRouter.on(
  ['GET', 'OPTIONS'],
  '/oauth-protected-resource/mcp/t/:slug',
  openCors,
  mcpDeploymentGate,
  c => protectedResource(c, c.req.param('slug'))
)

/** RFC 8414. No `registration_endpoint`: clients identify themselves by metadata document. */
function authorizationServer(c: AppContext) {
  const issuer = oauthIssuer(c.get('config'))
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  })
}

for (const path of ['/oauth-authorization-server', '/openid-configuration']) {
  wellKnownRouter.on(['GET', 'OPTIONS'], path, openCors, mcpDeploymentGate, authorizationServer)
}
