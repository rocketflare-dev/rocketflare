/**
 * Permission checks as a hook (D10): `can`/`cannot` over the session ability plus the three level
 * checks the kit's chrome needs. Level checks read the ability, not the role string, so a global
 * admin visiting as `support` and a real owner answer the same way the server would.
 */
import type { Actions, FeatureName, Subjects } from '@rocketflare/shared/permissions'
import { useMemo } from 'react'
import { useAbility } from '@/ui/components/permissions/AbilityContext'
import { useAuth } from './useAuth'

export function usePermissions() {
  const ability = useAbility()
  return useMemo(() => {
    const can = (action: Actions, subject: Subjects) => ability.can(action, subject)
    const cannot = (action: Actions, subject: Subjects) => ability.cannot(action, subject)
    return {
      ability,
      can,
      cannot,
      /** `manage all` — the platform flag */
      isGlobalAdmin: () => can('manage', 'all'),
      /** `manage Tenant` — owner (also support / global admin) */
      isOwnerLevel: () => can('manage', 'Tenant'),
      /** `manage TenantMember` — admin or above */
      isAdminLevel: () => can('manage', 'TenantMember'),
    }
  }, [ability])
}

/**
 * Is a feature on for this session (D30)? Reads `session.features` — the array the server resolved
 * — and NEVER the ability: `manage all` covers `access` on every `Feature:` subject, so an ability
 * check would answer "on" for a global admin whatever the deployment ships, while the server 404s
 * the routes underneath. A flag is configuration; no role overrides it.
 */
export function useFeature(name: FeatureName): boolean {
  const { session } = useAuth()
  return session?.features.includes(name) ?? false
}
