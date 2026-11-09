/**
 * Security headers on every response, set after `next()`. Placed early so it also covers 4xx/5xx
 * produced by later middleware. CSP is a constant list — append `connect-src` entries here when the UI talks to a third party. There is
 * ONE exception, opt-in per response: a route that has proved its content type may
 * `c.set('embeddable', true)` and get `SAMEORIGIN` + `frame-ancestors 'self'` instead, which is
 * what lets the document viewer frame a PDF. A 101
 * (WebSocket upgrade from the `NotificationsHub` DO) is returned untouched: its headers are
 * immutable and re-wrapping a 101 `Response` drops the socket.
 *
 * A second kind of response has its own policy: one from a public site host, where
 * `middleware/public-sites.ts` has set `publicSiteCsp`. Its bytes may come from the cache, which
 * holds no security headers, so this is the one place both hits and misses get theirs.
 */
import { createMiddleware } from 'hono/factory'
import type { PublicSiteCsp } from '../../plugins/types'
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

/**
 * A declared source that would weaken the public CSP: inline or eval script (a hash or nonce is
 * inline script too), a wildcard, `data:`, or anything that could smuggle in another source or
 * directive. `publicSiteIssues` fails the gate on one; at runtime it is dropped.
 */
export function isForbiddenCspSource(source: string): boolean {
  return /'unsafe-|'nonce-|'sha(?:256|384|512)-|\*|data:|;|\s/i.test(source)
}

/** The one path a public site's own scripts and styles load from. */
export const SITE_ASSETS_PATH = '/site-assets/'

/**
 * Would this `script-src` source let a page on `host` load the admin bundle from `/assets/*`?
 * `'self'`, a bare scheme, the host with no path and the host's `/assets/` all do.
 */
export function reachesAdminBundle(source: string, host: string): boolean {
  if (/^'self'$/i.test(source) || /^[a-z][a-z0-9+.-]*:$/i.test(source)) return true
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/]+)(\/.*)?$/i.exec(source)
  if (!match || match[1].toLowerCase().replace(/:\d+$/, '') !== host) return false
  const path = match[2]
  return !path || path === '/' || /^\/assets(\/|$)/.test(path)
}

/**
 * The strict policy of a public site, extended by what its developer declared. Scripts and styles
 * come from `SITE_ASSETS_PATH` on the request's own origin, port included, and never `'self'`: a
 * browser enforces the path, so a page cannot load the admin bundle even through an injection.
 */
export function publicSiteCsp(origin: string, declared: PublicSiteCsp = {}): string {
  const siteAssets = `${origin}${SITE_ASSETS_PATH}`
  const host = new URL(origin).hostname
  const allowed = (sources: readonly string[] = []) =>
    sources.filter(source => !isForbiddenCspSource(source))
  const orNone = (sources: readonly string[]) => (sources.length > 0 ? sources.join(' ') : "'none'")
  const scripts = allowed(declared.scriptSrc).filter(source => !reachesAdminBundle(source, host))
  return [
    "default-src 'none'",
    `script-src ${scripts.length > 0 ? [siteAssets, ...scripts].join(' ') : "'none'"}`,
    `style-src ${siteAssets}`,
    `img-src ${["'self'", ...allowed(declared.imgSrc)].join(' ')}`,
    "font-src 'self'",
    `connect-src ${orNone(allowed(declared.connectSrc))}`,
    `frame-src ${orNone(allowed(declared.frameSrc))}`,
    "base-uri 'none'",
    `form-action ${orNone(allowed(declared.formAction))}`,
    "frame-ancestors 'none'",
  ].join('; ')
}

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
    c.get('publicSiteCsp') ??
      (embeddable ? EMBEDDABLE_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY)
  )
})
