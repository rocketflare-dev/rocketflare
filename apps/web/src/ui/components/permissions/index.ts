/** Permission primitives for pages: provider, `IfCan`/`IfCannot`, `usePermissions`. */

export { usePermissions } from '@/ui/hooks/usePermissions'
export {
  AbilityProvider,
  type AppAbility,
  abilityFromPackedRules,
  emptyAbility,
  useAbility,
} from './AbilityContext'
export { IfCan, IfCannot } from './IfCan'
