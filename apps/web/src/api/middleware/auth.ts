/**
 * Authentication middleware (D10, D12, D25). Applied PER MOUNT in `index.ts`, never inside a
 * route file. Two credentials:
 *   - `Authorization: Bearer <api key>` → the key's tenant, acting as the key's creator
 *   - `__Host-session` cookie → `resolveSession` (one LATERAL query), sliding expiry via waitUntil
 * Builds `AuthContext` (`buildAbility({ role, isGlobalAdmin, features: [] })`) and `c.set('auth')`.
 * Errors are envelopes: 401 `unauthorized`; 403 `blocked` / `tenant_suspended`. A valid session
 * with NO tenant passes with `tenantId: null` — `withAuthAndDb` turns that into 403 `no_tenant` /
 * `pending_approval`, while tenant-free routes (`withAuth`) keep working.
 *
 * `globalAdminMiddleware` (`/api/admin/*`): cookie session with `users.isGlobalAdmin`, tenant-free
 * by design — the only cross-tenant auth path.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { createMiddleware } from 'hono/factory'
import { buildAbility } from '../../permissions'
import { touchApiKeyUsage, validateApiKey } from '../auth/api-keys'
import { readSessionToken } from '../auth/cookies'
import {
  deleteSession,
  resolveSession,
  touchSession,
  touchTenantAccess,
  updateSelectedTenant,
} from '../auth/sessions'
import type { AppContext, AppEnv, AuthContext } from '../types'
import { ForbiddenError, UnauthorizedError } from '../utils/core/errors'
import { deferOrAwait } from './database'

export const API_KEY_SESSION_PREFIX = 'api-key:'

export function isApiKeySession(auth: Pick<AuthContext, 'session'>): boolean {
  return auth.session.id.startsWith(API_KEY_SESSION_PREFIX)
}

/** Fire-and-forget side effect: `waitUntil` when available, awaited inline otherwise; never throws. */
export function fireAndForget(c: AppContext, work: () => Promise<unknown>, what: string): void {
  void deferOrAwait(c, () =>
    work().catch(err => {
      c.get('logger').warn({ err }, `Failed to ${what}`)
    })
  )
}

/**
 * Resolve the cookie session into an `AuthContext`, or null when there is no valid cookie.
 * Throws 403 `blocked` / `tenant_suspended`. Shared by `authMiddleware`, `globalAdminMiddleware`
 * and the public `/auth/*` routes that need to know who is asking (session, select-tenant, cli).
 */
export async function resolveCookieAuth(
  c: AppContext,
  token: string | undefined = readSessionToken(c)
): Promise<AuthContext | null> {
  if (!token) return null
  const db = c.get('db')
  const resolved = await resolveSession(db, token)
  if (!resolved) return null

  const { session, user, membership, accessRequestStatus } = resolved
  if (session.expiresAt.getTime() <= Date.now()) {
    fireAndForget(c, () => deleteSession(db, session.id), 'delete expired session')
    return null
  }
  if (user.blockedAt) throw new ForbiddenError('Account is blocked', ERROR_CODES.blocked)
  if (membership?.tenant.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }

  fireAndForget(c, () => touchSession(db, session.id), 'touch session')
  if (membership) {
    if (session.selectedTenantId !== membership.tenantId) {
      // The LATERAL join already fell back to another membership; persist the new selection.
      fireAndForget(
        c,
        () => updateSelectedTenant(db, session.id, membership.tenantId),
        'update selected tenant'
      )
    }
    fireAndForget(c, () => touchTenantAccess(db, membership.tenantId), 'touch tenant access')
  }

  return {
    user,
    tenantId: membership?.tenantId ?? null,
    tenantUser: membership ? { role: membership.role } : null,
    tenant: membership
      ? { id: membership.tenant.id, name: membership.tenant.name, slug: membership.tenant.slug }
      : null,
    session: { id: session.id },
    ability: buildAbility({
      role: membership?.role ?? null,
      isGlobalAdmin: user.isGlobalAdmin,
      features: [],
    }),
    isGlobalAdmin: user.isGlobalAdmin,
    features: [],
    accessRequestStatus,
  }
}

async function resolveBearerAuth(c: AppContext, plaintext: string): Promise<AuthContext> {
  const db = c.get('db')
  const result = await validateApiKey(db, plaintext)
  if (!result.ok) throw new UnauthorizedError('Invalid API key')
  if (result.user.blockedAt) throw new ForbiddenError('Account is blocked', ERROR_CODES.blocked)
  if (result.tenant.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }
  fireAndForget(c, () => touchApiKeyUsage(db, result.key.id), 'touch API key usage')
  fireAndForget(c, () => touchTenantAccess(db, result.tenant.id), 'touch tenant access')
  return {
    user: result.user,
    tenantId: result.tenant.id,
    tenantUser: { role: result.role },
    tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
    session: { id: `${API_KEY_SESSION_PREFIX}${result.key.id}` },
    ability: buildAbility({
      role: result.role,
      isGlobalAdmin: result.user.isGlobalAdmin,
      features: [],
    }),
    isGlobalAdmin: result.user.isGlobalAdmin,
    features: [],
    accessRequestStatus: null,
  }
}

function bearerToken(c: AppContext): string | undefined {
  const header = c.req.header('Authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = bearerToken(c)
  const auth = bearer ? await resolveBearerAuth(c, bearer) : await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  c.set('auth', auth)
  await next()
})

export const globalAdminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  if (!auth.isGlobalAdmin) throw new ForbiddenError('Global admin access required')
  c.set('auth', auth)
  await next()
})
