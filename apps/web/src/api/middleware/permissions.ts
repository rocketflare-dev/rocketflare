/**
 * Route-level authorisation helpers over the request's CASL ability (D10, D13). Everything reads
 * `c.get('auth')` — set by `authMiddleware` — and THROWS typed errors so `error-handler.ts` renders
 * the shared envelope; nothing here builds a Response. Owner-only decisions use `isOwnerLevel`
 * (explicit role), never `can('manage', 'Tenant')`, which `support` and global admins also hold.
 */
import type { Actions, Subjects } from '@gmgo/shared/permissions'
import type { MembershipRole } from '@gmgo/shared/tenants'
import type { AppContext, AuthContext } from '../types'
import { ForbiddenError, UnauthorizedError } from '../utils/core/errors'

/** The auth context or a 401 — for helpers that must not run unauthenticated. */
export function requireAuth(c: AppContext): AuthContext {
  const auth = c.get('auth')
  if (!auth) throw new UnauthorizedError()
  return auth
}

/** `true` when the request may `action` the `subject`; `false` when unauthenticated. */
export function can(c: AppContext, action: Actions, subject: Subjects): boolean {
  return c.get('auth')?.ability.can(action, subject) ?? false
}

/**
 * Throw 401 without auth, 403 `forbidden` without the permission; otherwise return the auth
 * context so a handler can chain: `const { tenantId } = guardPermission(c, 'manage', 'ApiKey')`.
 */
export function guardPermission(c: AppContext, action: Actions, subject: Subjects): AuthContext {
  const auth = requireAuth(c)
  if (!auth.ability.can(action, subject)) {
    throw new ForbiddenError(`You do not have permission to ${action} ${subject}`)
  }
  return auth
}

/** The subset of `AuthContext` the role helpers need — so tests and services can pass a literal. */
export interface RoleView {
  isGlobalAdmin: boolean
  tenantUser: { role: MembershipRole } | null
}

/** `users.isGlobalAdmin` — the platform flag, independent of any tenant role. */
export function isGlobalAdmin(session: RoleView): boolean {
  return session.isGlobalAdmin === true
}

/** Irreversible tenant actions: explicit `owner` (or global admin), NOT `manage Tenant`. */
export function isOwnerLevel(session: RoleView): boolean {
  return isGlobalAdmin(session) || session.tenantUser?.role === 'owner'
}

/** May administer members / invitations / keys: owner, admin, support, or global admin. */
export function isAdminLevel(session: RoleView): boolean {
  if (isGlobalAdmin(session)) return true
  const role = session.tenantUser?.role
  return role === 'owner' || role === 'admin' || role === 'support'
}

/** Throw 403 unless `isOwnerLevel` — the explicit check the matrix defers to routes. */
export function guardOwner(c: AppContext): AuthContext {
  const auth = requireAuth(c)
  if (!isOwnerLevel(auth)) throw new ForbiddenError('Only the organisation owner can do this')
  return auth
}
