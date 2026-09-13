/**
 * Security headers on every response (04 §4: the Workers app's minimal set, the Node app's post-`next()`
 * placement). Placed early so it also covers 4xx/5xx produced by later middleware. CSP is a
 * constant list — append `connect-src` entries here when the UI talks to a third party. There is
 * ONE exception, opt-in per response: a route that has proved its content type may
 * `c.set('embeddable', true)` and get `SAMEORIGIN` + `frame-ancestors 'self'` instead, which is
 * what lets the document viewer frame a PDF (D18). A 101
 * (WebSocket upgrade from the `NotificationsHub` DO, D8) is returned untouched: its headers are
 * immutable and re-wrapping a 101 `Response` drops the socket.
 */
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

/** Every directive except `frame-ancestors`, so the two policies below cannot drift apart. */
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' https: data:",
  "connect-src 'self' wss: https:",
  "base-uri 'self'",
  "form-action 'self'",
]

/** The app shell and every JSON route: framable by nobody, including us. */
export const CONTENT_SECURITY_POLICY = [...CSP_BASE, "frame-ancestors 'none'"].join('; ')

/**
 * The ONE relaxation, for a response a route has opted in with `c.set('embeddable', true)` — today
 * exactly one class: a PDF byte stream from `/api/files/:id`, served `nosniff` with no script
 * context, so the document viewer can render it in the page. `DENY` forbids framing by ANY origin
 * including our own, so without this an `<object>` embed renders empty whatever the
 * `Content-Disposition` says. The app shell stays `'none'`.
 */
export const EMBEDDABLE_CONTENT_SECURITY_POLICY = [...CSP_BASE, "frame-ancestors 'self'"].join('; ')

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  if (c.res.status === 101) return
  // HSTS is meaningless on http://localhost and would pin the browser if it ever saw https there.
  if (c.get('config')?.APP_ENV !== 'development') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  c.header('X-Content-Type-Options', 'nosniff')
  const embeddable = c.get('embeddable') === true
  c.header('X-Frame-Options', embeddable ? 'SAMEORIGIN' : 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  c.header(
    'Content-Security-Policy',
    embeddable ? EMBEDDABLE_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY
  )
})
