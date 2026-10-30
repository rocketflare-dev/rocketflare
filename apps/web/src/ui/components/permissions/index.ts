/** Permission primitives for pages: provider, `Can`, `IfCan`/`IfCannot`, `usePermissions`. */

export { usePermissions } from '@/ui/hooks/usePermissions'
export {
  AbilityContext,
  AbilityProvider,
  type AppAbility,
  abilityFromPackedRules,
  Can,
  emptyAbility,
  useAbility,
} from './AbilityContext'
export { IfCan, IfCannot } from './IfCan'
