/**
 * Permission checks as a hook (D10): `can`/`cannot` over the session ability plus the three level
 * checks the kit's chrome needs. Level checks read the ability, not the role string, so a global
 * admin visiting as `support` and a real owner answer the same way the server would.
 */
import type { Actions, Subjects } from '@gmgo/shared/permissions'
import { useMemo } from 'react'
import { useAbility } from '@/ui/components/permissions/AbilityContext'

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
