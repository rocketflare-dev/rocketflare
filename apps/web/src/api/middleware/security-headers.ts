/**
 * Security headers on every response (04 §4: the Workers app's minimal set, the Node app's post-`next()`
 * placement). Placed early so it also covers 4xx/5xx produced by later middleware. CSP is a
 * constant list — append `connect-src` entries here when the UI talks to a third party.
 */
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' https: data:",
  "connect-src 'self' wss: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  // HSTS is meaningless on http://localhost and would pin the browser if it ever saw https there.
  if (c.get('config')?.APP_ENV !== 'development') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
})
