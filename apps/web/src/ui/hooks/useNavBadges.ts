/**
 * Counts the SideNav renders beside an item.
 *
 * `navigationConfig` stays a plain const consumed by the pure, tested `filterNavConfig` — making it
 * a hook would put a React dependency inside the one piece of navigation that is currently data.
 * So a `NavItem` declares a `badgeKey` and this resolves it, once, in `SideNav`.
 *
 * Each entry is gated on the same guard as the item it decorates, so a member never fires a request
 * for a count they would not be shown.
 */
import { KNOWLEDGE_FACTS_GUARD } from '@/ui/lib/feature-guards'
import { useAwaitingInterruptCount } from './useAgents'
import { useMyReviewCount } from './useKnowledge'
import type { NavGuard } from './useNavGuard'
import { useNavGuard } from './useNavGuard'

/** The keys a `NavItem.badgeKey` may name. A key with no entry simply renders nothing. */
export type NavBadgeKey = 'agentsAwaiting' | 'knowledgeReview'

const BADGE_GUARDS: Record<NavBadgeKey, NavGuard> = {
  agentsAwaiting: { action: 'read', subject: 'AgentRun' },
  // On the Knowledge item, but behind the knowledge-facts flag as well as its permission: a
  // tenant without the flag never asks (the route would 404).
  knowledgeReview: KNOWLEDGE_FACTS_GUARD,
}

export type NavBadges = Partial<Record<NavBadgeKey, number>>

export function useNavBadges(): NavBadges {
  const canAccess = useNavGuard()
  const awaiting = useAwaitingInterruptCount(canAccess(BADGE_GUARDS.agentsAwaiting))
  const review = useMyReviewCount(canAccess(BADGE_GUARDS.knowledgeReview))
  const badges: NavBadges = {}
  // Zero is not a badge — an empty inbox should look like an empty inbox, not like a nought.
  if ((awaiting.data ?? 0) > 0) badges.agentsAwaiting = awaiting.data
  if ((review.data ?? 0) > 0) badges.knowledgeReview = review.data
  return badges
}
