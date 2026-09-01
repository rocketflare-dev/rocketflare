import { useCallback } from 'react'

/**
 * A guard on a nav item or route. Coarse role flags for routing (`AdminRoute` /
 * `GlobalAdminRoute` semantics, D10) or a CASL `{ action, subject }` pair for per-page checks.
 * SideNav items and `RequireGuard` use the SAME type and the SAME hook, so a link never points
 * at a page its reader may not open.
 */
export type NavGuard = 'admin' | 'globalAdmin' | { action: string; subject: string }

/**
 * Returns `canAccess(guard)`. Phase 0 has no session, so everything is allowed.
 *
 * Phase 1: read `useAuth()` (role, isGlobalAdmin) and `useAbility()` and return
 *   'admin'       → role ∈ owner|admin|support || isGlobalAdmin
 *   'globalAdmin' → user.isGlobalAdmin
 *   { action, subject } → ability.can(action, subject)
 * Nothing else in the UI needs to change.
 */
export function useNavGuard(): (guard: NavGuard | undefined) => boolean {
  return useCallback((_guard: NavGuard | undefined) => true, [])
}
