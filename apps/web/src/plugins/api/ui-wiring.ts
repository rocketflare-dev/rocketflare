/**
 * The WIRING half of the UI kit (D31) — the only host module a plugin's `ui/index.ts` may import.
 *
 * **That file ships in the MAIN bundle, for every reader, including the ones who never open the
 * plugin.** `App.tsx` and `SideNav` import the barrel that imports it, so anything it pulls in at
 * runtime is in everybody's first download. So this half is types, one tiny helper and one hook —
 * the vocabulary a nav item and a route need and nothing else.
 *
 * The components half is `./ui`, and a plugin's UI ENTRY must not import it: components are for
 * PAGES, which arrive as `lazy(() => import(...))` and live in their own chunk. This is not new
 * policy — `uiEntryIssues` in `tests/helpers/plugins.ts` has always drawn exactly this line; what
 * is new is that there is now one module on each side of it, so the line is a place rather than a
 * rule you have to remember.
 *
 * One const per feature, used by the route AND its nav item, is the pattern: a link can then never
 * point at a page its reader cannot open. And a flag is spelled `{ feature }`, never
 * `{ action: 'access', subject: 'Feature:x' }` — a global admin's `manage all` satisfies the CASL
 * form, which would show them a nav item whose routes the server 404s.
 */

export type { NavConfig, NavGroup, NavItem } from '../../ui/components/SideNav'
export type { TabConfig } from '../../ui/components/shared'
export type { NavGuard } from '../../ui/hooks/useNavGuard'
export { isGuardList, useNavGuard } from '../../ui/hooks/useNavGuard'
export { featureGuard } from '../../ui/lib/feature-guards'
export type { QuickLink } from '../../ui/pages/Home'

export type {
  AnyUiPlugin,
  PluginNavGroup,
  PluginRoute,
  PluginRouteTier,
  UiPlugin,
} from '../types'
