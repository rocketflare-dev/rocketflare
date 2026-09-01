/**
 * CSRF protection for cookie-authenticated unsafe requests (ported from the Node reference app
 * `src/api/middleware/csrf.ts`; origins from config instead of hardcoded ports). Pure Web API,
 * no DB, runs before auth using only the raw cookie header.
 *
 * Contract:
 * - safe methods (GET/HEAD/OPTIONS) pass
 * - `Authorization: Bearer` (API key) requests are exempt — not cookie-based
 * - requests WITHOUT the session cookie pass (nothing to forge)
 * - with the cookie: `Sec-Fetch-Site` must be same-origin/same-site/none, and `Origin`
 *   (else `Referer`) must be an allowed origin; a missing Origin+Referer is allowed (non-browser)
 * Failures throw `ForbiddenError` with `code: 'csrf_failed'`.
 */
import { ERROR_CODES } from '@gmgo/shared/errors'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { SESSION_COOKIE_NAME } from '../auth/cookies'
import type { AppEnv } from '../types'
import { ForbiddenError } from '../utils/core/errors'
import { allowedOrigins } from './cors'

/** D12: `__Host-` prefix = Secure, Path=/, no Domain — defined once in auth/cookies.ts. */
export { SESSION_COOKIE_NAME }

const SAME_SITE_FETCH_VALUES = new Set(['same-origin', 'same-site', 'none'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function isAllowedOrigin(value: string, allowed: Set<string>): boolean {
  try {
    return allowed.has(new URL(value).origin)
  } catch {
    return false
  }
}

export const csrfProtection = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next()
  if (c.req.header('Authorization')?.startsWith('Bearer ')) return next()
  if (!getCookie(c, SESSION_COOKIE_NAME)) return next()

  const secFetchSite = c.req.header('Sec-Fetch-Site')?.toLowerCase()
  if (secFetchSite && !SAME_SITE_FETCH_VALUES.has(secFetchSite)) {
    throw new ForbiddenError('Cross-site request blocked', ERROR_CODES.csrf)
  }

  const allowed = allowedOrigins(c.get('config'))
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin, allowed)) {
    throw new ForbiddenError('Invalid request origin', ERROR_CODES.csrf)
  }
  const referer = c.req.header('Referer')
  if (!origin && referer && !isAllowedOrigin(referer, allowed)) {
    throw new ForbiddenError('Invalid request origin', ERROR_CODES.csrf)
  }

  await next()
})
