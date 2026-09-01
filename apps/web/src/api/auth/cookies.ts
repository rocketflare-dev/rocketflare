/**
 * Every cookie the auth surface sets (D12): the `__Host-session` login cookie and the short-lived
 * flow cookies (OAuth state, CLI hand-off). One helper, driven by config, so no route hand-rolls a
 * `Set-Cookie` string. `__Host-` REQUIRES `Secure` + `Path=/` + no `Domain` (browsers drop it
 * otherwise, and hono's serializer throws), so the session cookie is Secure in every environment —
 * `http://localhost` is a secure context in Chrome/Firefox; use `pnpm dev:tunnel` for Safari.
 */
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppConfig } from '../../config'
import type { AppContext } from '../types'

/** The login cookie. `middleware/csrf.ts` re-exports this so the CSRF check names the same cookie. */
export const SESSION_COOKIE_NAME = '__Host-session'
/** Carries `{ provider, state, verifier, redirectTo?, link? }` for one OAuth round trip. */
export const OAUTH_STATE_COOKIE_NAME = 'oauth_state'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FLOW_COOKIE_TTL_S = 10 * 60

/** `Secure` for the non-`__Host-` flow cookies: on everywhere but plain-http development. */
export function secureCookies(cfg: AppConfig): boolean {
  return cfg.APP_ENV !== 'development' || cfg.APP_URL.startsWith('https://')
}

export function setSessionCookie(c: AppContext, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: true })
}

export function readSessionToken(c: AppContext): string | undefined {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  return token && token.length > 0 ? token : undefined
}

/** A 10-minute HttpOnly cookie for an in-flight auth flow (OAuth state, CLI redirect). */
export function setFlowCookie(c: AppContext, cfg: AppConfig, name: string, value: string): void {
  setCookie(c, name, value, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: secureCookies(cfg),
    path: '/',
    maxAge: FLOW_COOKIE_TTL_S,
  })
}

export function clearFlowCookie(c: AppContext, cfg: AppConfig, name: string): void {
  deleteCookie(c, name, { path: '/', secure: secureCookies(cfg) })
}

export function readFlowCookie(c: AppContext, name: string): string | undefined {
  return getCookie(c, name)
}
