/**
 * Counts the SideNav renders beside an item (issue #17).
 *
 * `navigationConfig` stays a plain const consumed by the pure, tested `filterNavConfig` — making it
 * a hook would put a React dependency inside the one piece of navigation that is currently data.
 * So a `NavItem` declares a `badgeKey` and this resolves it, once, in `SideNav`.
 *
 * Each entry is gated on the same guard as the item it decorates, so a member never fires a request
 * for a count they would not be shown.
 */
import { useAwaitingInterruptCount } from './useAgents'
import type { NavGuard } from './useNavGuard'
import { useNavGuard } from './useNavGuard'

/** The keys a `NavItem.badgeKey` may name. A key with no entry simply renders nothing. */
export type NavBadgeKey = 'agentsAwaiting'

const BADGE_GUARDS: Record<NavBadgeKey, NavGuard> = {
  agentsAwaiting: { action: 'read', subject: 'AgentRun' },
}

export type NavBadges = Partial<Record<NavBadgeKey, number>>

export function useNavBadges(): NavBadges {
  const canAccess = useNavGuard()
  const awaiting = useAwaitingInterruptCount(canAccess(BADGE_GUARDS.agentsAwaiting))
  const count = awaiting.data ?? 0
  // Zero is not a badge — an empty inbox should look like an empty inbox, not like a nought.
  return count > 0 ? { agentsAwaiting: count } : {}
}
