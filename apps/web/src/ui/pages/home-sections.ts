/**
 * Home's work areas as data. `Home` renders every section whose guard passes, in `order` within
 * its `placement`. A FEATURE contributes its own section here — one entry, pointing at a component
 * in the feature's own directory — so a copy that deletes the feature deletes its entry and Home
 * loses the area with nothing else to edit. Core's sections (team, spend, activity) live in
 * `./home/`. An installed PLUGIN does not edit this file: its cards are `UiPlugin.homeCards`.
 *
 * A leaf module, like `home-links.ts`: the feature sections are lazy imports, so this file pulls no
 * feature code into the eager bundle. Each section reads its own part of `useHomeSummary()` and
 * renders `null` when its part is `null` (the reader may not see it).
 */
import { type ComponentType, lazy } from 'react'
import type { NavGuard } from '@/ui/hooks/useNavGuard'
import { HomeActivity } from './home/HomeActivity'
import { HomeSpend } from './home/HomeSpend'
import { HomeTeam } from './home/HomeTeam'

/**
 * Where a section sits: `lead` spans the page above the columns, `main` is the wide column (the
 * work), `aside` the narrow one (the people and what happened). On a narrow screen they stack in
 * that order.
 */
export type HomePlacement = 'lead' | 'main' | 'aside'

export interface HomeSection {
  id: string
  placement: HomePlacement
  /** Lower first within a placement. */
  order: number
  /** Decided by `useNavGuard`, like a nav item. The section's own `null` part hides it too. */
  guard?: NavGuard
  Component: ComponentType
}

export const HOME_SECTIONS: readonly HomeSection[] = [
  // feature-chat
  {
    id: 'chat',
    placement: 'lead',
    order: 0,
    guard: { action: 'read', subject: 'Conversation' },
    Component: lazy(() => import('./chat/HomeComposer')),
  },
  // feature-agents
  {
    id: 'agents',
    placement: 'main',
    order: 0,
    guard: { action: 'read', subject: 'AgentRun' },
    Component: lazy(() => import('./agents/HomeRuns')),
  },
  // feature-knowledge
  // In the narrow column: its rows are a title and a date, and the runs area alone is as tall
  // as the team and the activity together, so the two columns end level.
  {
    id: 'knowledge',
    placement: 'aside',
    order: 5,
    guard: { action: 'read', subject: 'Document' },
    Component: lazy(() => import('./documents/HomeDocuments')),
  },
  { id: 'spend', placement: 'aside', order: 0, guard: 'admin', Component: HomeSpend },
  { id: 'team', placement: 'aside', order: 10, Component: HomeTeam },
  { id: 'activity', placement: 'aside', order: 20, guard: 'admin', Component: HomeActivity },
]

/** The sections of one placement in order. Pure. */
export function sectionsFor(
  sections: readonly HomeSection[],
  placement: HomePlacement
): HomeSection[] {
  return sections
    .filter(s => s.placement === placement)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}
