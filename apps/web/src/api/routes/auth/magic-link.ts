/**
 * Magic-link login. `POST /request` always answers 202 (anti-enumeration) and is
 * rate-limited at the mount; the email — or, with no `RESEND_API_KEY`, the log line — carries
 * `${APP_URL}/auth/magic-link/verify?token=…`.
 *
 * Scanner-safe verify: `GET /verify` consumes NOTHING — it 302s to the SPA's
 * `/magic-link/confirm`, whose "Sign in" button posts a native form back to `POST /verify`. Mail
 * security scanners (Defender Safe Links, Mimecast, Proofpoint) GET every link on delivery; when
 * GET consumed the token, the scanner spent it and the person's own click got `invalid_token`.
 * `POST /verify` consumes the token, runs `admitUser` (sign-up gating), sets the cookie and 303s to
 * the validated `redirectTo` or `/`; failures redirect to
 * `/login?error=invalid_token|expired|not_invited|blocked`.
 *
 * **SSO required** (`ServerPlugin.ssoPolicy`, `api/auth/sso-policy.ts`): for an address whose
 * domain a plugin's connection claims, `POST /request` mints NO token and sends a token-free "use
 * single sign-on" email pointing at `/login?error=sso_required&method=…` instead — still 202, the
 * same body, so the response says nothing about the address. `POST /verify` asks again after
 * consuming, so a link minted before the policy existed (or by `requestMagicLink` directly) is
 * refused with `sso_required` too.
 *
 * `AUTH_OIDC_ONLY`: the method is off. `POST /request` still answers 202 and mints nothing;
 * `POST /verify` redirects to `/login?error=oidc_only` before touching the token.
 *
 * Per recipient: past `RECIPIENT_MAIL_MAX` sign-in mails to one address in the window, `POST
 * /request` still answers 202 and neither mints a token nor sends anything.
 *
 * `POST /verify` signs in only from the app's own origin: it runs the same Origin / fetch-metadata
 * check as the CSRF middleware, which skips a request with no session cookie.
 */
import { magicLinkRequestSchema } from '@rocketflare/shared/auth'
import { type AppConfig, isOidcOnly } from '../../../config'
import type { Database } from '../../../db/client'
import { consumeMagicLinkToken, issueMagicLinkToken } from '../../auth/magic-link'
import { ssoAllows, ssoRequiredLoginPath } from '../../auth/sso-policy'
import { assertSameOriginRequest } from '../../middleware/csrf'
import { checkRateLimit, type RateLimitKv } from '../../middleware/rate-limit'
import { admitUser } from '../../services/auth'
import { magicLinkEmail, sendEmail, ssoRequiredEmail } from '../../services/email'
import { hashToken } from '../../utils/core/hash'
import type { Logger } from '../../utils/core/logger'
import { createRouter } from '../../utils/routes/router'
import { validate } from '../../utils/routes/validate'
import { completeLogin, loginErrorRedirect, safeRedirectPath, ssoRequiredRedirect } from './helpers'
import { ssoDecisionFor } from './sso'

export const magicLinkRouter = createRouter()

export function verifyUrl(cfg: AppConfig, token: string): string {
  const url = new URL('/auth/magic-link/verify', cfg.APP_URL)
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * Issue + send, with NO SSO check — the route applies the policy (`requestSignInEmail`) and
 * `POST /verify` re-checks it, which is what refuses a link minted here for a required domain.
 * Returns the URL so callers that OWN the request (tests, scripts) can follow it;
 * the route never puts it in the response.
 */
export async function requestMagicLink(
  db: Database,
  cfg: AppConfig,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  input: { email: string; redirectTo?: string | null }
): Promise<{ verifyUrl: string; expiresAt: Date }> {
  const redirectTo = input.redirectTo ? safeRedirectPath(input.redirectTo) : null
  const { token, expiresAt } = await issueMagicLinkToken(db, input.email, redirectTo)
  const url = verifyUrl(cfg, token)
  await sendEmail(cfg, logger, magicLinkEmail(cfg, input.email.toLowerCase(), url))
  return { verifyUrl: url, expiresAt }
}

export type SignInEmailResult =
  | { kind: 'magic_link'; verifyUrl: string; expiresAt: Date }
  | { kind: 'sso_required'; loginUrl: string }

/**
 * What `POST /request` sends: a magic link, or — when a plugin's policy says the address must use
 * single sign-on — a token-free email linking to the login page with that method preselected.
 * Returned so tests can tell which; the route answers 202 either way.
 */
export async function requestSignInEmail(
  db: Database,
  cfg: AppConfig,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  input: { email: string; redirectTo?: string | null }
): Promise<SignInEmailResult> {
  const email = input.email.toLowerCase()
  const decision = await ssoDecisionFor(db, cfg, [email], logger)
  if (ssoAllows(decision, 'core')) {
    return { kind: 'magic_link', ...(await requestMagicLink(db, cfg, logger, input)) }
  }
  const returnUrl = input.redirectTo ? safeRedirectPath(input.redirectTo) : null
  // The mail goes only to the address itself, so prefilling it on the login page is no leak.
  const loginUrl = new URL(ssoRequiredLoginPath(decision, { returnUrl, email }), cfg.APP_URL)
  const label = decision.required ? decision.label : undefined
  await sendEmail(cfg, logger, ssoRequiredEmail(cfg, email, loginUrl.toString(), label))
  return { kind: 'sso_required', loginUrl: loginUrl.toString() }
}

const RECIPIENT_MAIL_MAX = 5
const RECIPIENT_MAIL_WINDOW_SECONDS = 15 * 60

/** Whether this address has mail budget left; the bucket key holds a hash, never the address. */
async function recipientMailAllowed(kv: RateLimitKv | undefined, email: string): Promise<boolean> {
  if (!kv) return true
  const bucket = await hashToken(email.toLowerCase())
  const decision = await checkRateLimit(kv, `rl:auth-email:${bucket}`, {
    max: RECIPIENT_MAIL_MAX,
    windowSeconds: RECIPIENT_MAIL_WINDOW_SECONDS,
  })
  return decision.allowed
}

magicLinkRouter.post('/request', validate('json', magicLinkRequestSchema), async c => {
  const { email, redirectTo } = c.req.valid('json')
  const cfg = c.get('config')
  if (
    !isOidcOnly(cfg) &&
    (await recipientMailAllowed(c.env.RATE_LIMIT_KV as RateLimitKv | undefined, email))
  ) {
    await requestSignInEmail(c.get('db'), cfg, c.get('logger'), { email, redirectTo })
  }
  return c.json({ ok: true }, 202)
})

/** Link from the email: never consumes (see header) — hands the token to the confirm page. */
magicLinkRouter.get('/verify', c => {
  const params = new URLSearchParams({ token: c.req.query('token') ?? '' })
  const redirectTo = c.req.query('redirectTo')
  if (redirectTo) params.set('redirectTo', redirectTo)
  return c.redirect(`/magic-link/confirm?${params}`, 302)
})

/** The confirm page's form (`application/x-www-form-urlencoded`): the only consuming request. */
magicLinkRouter.post('/verify', async c => {
  assertSameOriginRequest(c)
  const db = c.get('db')
  const cfg = c.get('config')
  const logger = c.get('logger')
  if (isOidcOnly(cfg)) return loginErrorRedirect(c, 'oidc_only')
  const form = await c.req.parseBody()
  const token = typeof form.token === 'string' ? form.token : ''
  const consumed = await consumeMagicLinkToken(db, token)
  if (!consumed.ok) return loginErrorRedirect(c, consumed.reason)

  // Re-asked here, not only at request time: a link minted before the policy existed is refused.
  const requested = typeof form.redirectTo === 'string' ? form.redirectTo : null
  const sso = await ssoDecisionFor(db, cfg, [consumed.email], logger)
  if (!ssoAllows(sso, 'core')) {
    return ssoRequiredRedirect(c, sso, {
      returnUrl: safeRedirectPath(requested || consumed.redirectTo),
    })
  }

  const admitted = await admitUser(
    db,
    cfg,
    { email: consumed.email, verified: true, proof: 'kit' },
    logger
  )
  if (!admitted.ok) return loginErrorRedirect(c, admitted.reason)

  await completeLogin(c, db, cfg, admitted.user)
  const target = safeRedirectPath(requested || consumed.redirectTo)
  // 303: the browser follows a POST's redirect with a GET.
  return c.redirect(target, 303)
})
