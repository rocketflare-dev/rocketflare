/**
 * Magic-link login (D9, D11, D12). `POST /request` always answers 202 (anti-enumeration) and is
 * rate-limited at the mount; the email — or, with no `RESEND_API_KEY`, the log line — carries
 * `${APP_URL}/auth/magic-link/verify?token=…`. `GET /verify` consumes the token, runs `admitUser`
 * (sign-up gating), sets the cookie and 302s to the validated `redirectTo` or `/`; failures 302 to
 * `/login?error=invalid_token|expired|not_invited|blocked`.
 */
import { magicLinkRequestSchema } from '@rocketflare/shared/auth'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { consumeMagicLinkToken, issueMagicLinkToken } from '../../auth/magic-link'
import { admitUser } from '../../services/auth'
import { magicLinkEmail, sendEmail } from '../../services/email'
import type { Logger } from '../../utils/core/logger'
import { createRouter } from '../../utils/routes/router'
import { validate } from '../../utils/routes/validate'
import { completeLogin, loginErrorRedirect, safeRedirectPath } from './helpers'

export const magicLinkRouter = createRouter()

export function verifyUrl(cfg: AppConfig, token: string): string {
  const url = new URL('/auth/magic-link/verify', cfg.APP_URL)
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * Issue + send. Returns the URL so callers that OWN the request (tests, scripts) can follow it;
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

magicLinkRouter.post('/request', validate('json', magicLinkRequestSchema), async c => {
  const { email, redirectTo } = c.req.valid('json')
  await requestMagicLink(c.get('db'), c.get('config'), c.get('logger'), { email, redirectTo })
  return c.json({ ok: true }, 202)
})

magicLinkRouter.get('/verify', async c => {
  const db = c.get('db')
  const cfg = c.get('config')
  const logger = c.get('logger')
  const token = c.req.query('token') ?? ''
  const consumed = await consumeMagicLinkToken(db, token)
  if (!consumed.ok) return loginErrorRedirect(c, consumed.reason)

  const admitted = await admitUser(db, cfg, { email: consumed.email, verified: true }, logger)
  if (!admitted.ok) return loginErrorRedirect(c, admitted.reason)

  await completeLogin(c, db, cfg, admitted.user)
  const target = safeRedirectPath(c.req.query('redirectTo') ?? consumed.redirectTo)
  return c.redirect(target, 302)
})
