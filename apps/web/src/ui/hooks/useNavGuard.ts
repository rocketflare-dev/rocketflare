/**
 * The ONE place nav visibility and route access are decided (D10). SideNav items and
 * `RequireGuard` share the type and the hook, so a link never points at a page its reader may
 * not open. Cosmetic — the server enforces on every request.
 */
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import { useCallback } from 'react'
import { useAbility } from '@/ui/components/permissions/AbilityContext'
import { useAuth } from './useAuth'

/**
 * Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics) or a CASL
 * `{ action, subject }` pair for per-page checks. Strings, not the typed unions, so apps can
 * add subjects without touching the shell; the pair is cast when it reaches the ability.
 */
export type NavGuard = 'admin' | 'globalAdmin' | { action: string; subject: string }

const ADMIN_ROLES = new Set(['owner', 'admin', 'support'])

export function useNavGuard(): (guard: NavGuard | undefined) => boolean {
  const { tenant, isGlobalAdmin } = useAuth()
  const ability = useAbility()
  const role = tenant?.role ?? null

  const hasTenant = tenant !== null

  return useCallback(
    (guard: NavGuard | undefined) => {
      if (guard === undefined) return true
      if (guard === 'globalAdmin') return isGlobalAdmin
      // Without an organisation only the cross-tenant admin area is openable — a global admin's
      // `manage all` would otherwise light up every tenant page, each bouncing to `noTenantRoute`
      if (!hasTenant) return false
      // `support` is a global admin visiting this org; global admins hold `manage all` server-side
      if (guard === 'admin') return isGlobalAdmin || (role !== null && ADMIN_ROLES.has(role))
      return ability.can(guard.action as Actions, guard.subject as Subjects)
    },
    [ability, hasTenant, isGlobalAdmin, role]
  )
}
