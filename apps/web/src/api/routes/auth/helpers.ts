/**
 * Shared login-completion plumbing for every `/auth/*` flow (D9, D12): mint the session for the
 * user's default tenant, set the cookie, and validate redirect targets (same-origin paths only —
 * the open-redirect guard). Error redirects land on `/login?error=<code>`.
 */
import { redirectToSchema } from '@rocketflare/shared/auth'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { User } from '../../../db/schema'
import { setSessionCookie } from '../../auth/cookies'
import { createSession } from '../../auth/sessions'
import { defaultTenantFor } from '../../services/auth'
import type { AppContext } from '../../types'

export type LoginErrorCode =
  | 'invalid_token'
  | 'expired'
  | 'not_invited'
  | 'blocked'
  | 'email_unverified'
  | 'oauth_failed'
  | 'oauth_state_mismatch'
  | 'provider_linked_elsewhere'

/** A relative same-origin path, else `fallback`. Never `/login` (redirect loop). */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (!value) return fallback
  const parsed = redirectToSchema.safeParse(value)
  if (!parsed.success) return fallback
  if (parsed.data === '/login' || parsed.data.startsWith('/login?')) return fallback
  return parsed.data
}

export function loginErrorRedirect(c: AppContext, code: LoginErrorCode): Response {
  return c.redirect(`/login?error=${code}`, 302)
}

export function clientIpOf(c: AppContext): string | null {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  )
}

/** Session for the user's oldest membership (or none), cookie set. Returns the session id. */
export async function completeLogin(
  c: AppContext,
  db: Database,
  _cfg: AppConfig,
  user: User,
  selectedTenantId?: string | null
): Promise<{ sessionId: string; tenantId: string | null; token: string }> {
  const tenantId = selectedTenantId ?? (await defaultTenantFor(db, user.id))
  const session = await createSession(db, {
    userId: user.id,
    selectedTenantId: tenantId,
    ip: clientIpOf(c),
    userAgent: c.req.header('user-agent') ?? null,
  })
  setSessionCookie(c, session.token, session.expiresAt)
  return { sessionId: session.id, tenantId, token: session.token }
}
