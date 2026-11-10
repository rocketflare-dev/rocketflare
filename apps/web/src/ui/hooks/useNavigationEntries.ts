/**
 * Every place in the app the signed-in reader may open, as a flat list — for a command palette or
 * any other "go to" surface. Three sources, each filtered by the SAME guards that hide it
 * elsewhere (`useNavGuard`), so the list never offers a door the page would refuse:
 *
 * - the side navigation exactly as `SideNav` composes it (`composeNav` over `CORE_NAVIGATION` and
 *   every plugin's `nav` groups),
 * - the `/settings?tab=` tabs: the core ones (`pages/settings/tabs.ts`, the list `SettingsLayout`
 *   renders) and every plugin's `settingsTabs({ can })`, all behind the page's own `admin` guard,
 * - the Home quick links: every plugin's `homeLinks` and the core ones (Profile, Notifications…).
 *
 * The first entry for a path wins, so a quick link repeating a nav item is listed once. Order is
 * nav, then settings tabs, then quick links — a consumer ranks it however it likes.
 */
import type { Actions, Subjects } from '@rocketflare/shared/permissions'
import { type ComponentType, useMemo } from 'react'
import type { AnyUiPlugin } from '@/plugins/types'
import { uiPlugins } from '@/plugins/ui'
import {
  CORE_NAVIGATION,
  composeNav,
  filterNavConfig,
  isNavGroup,
  type NavItem,
} from '@/ui/components/SideNav'
import { CORE_QUICK_LINKS } from '@/ui/pages/Home'
import { CORE_SETTINGS_TABS, SETTINGS_PAGE_GUARD, settingsTabPath } from '@/ui/pages/settings/tabs'
import { type NavGuard, useNavGuard } from './useNavGuard'
import { usePermissions } from './usePermissions'

export interface NavigationEntry {
  /** Stable: `nav:<to>`, `settings:<tab id>` or `link:<to>`. */
  id: string
  label: string
  /** An in-app path, ready for `navigate()` / `<Link to>`. */
  to: string
  /** Where it lives: the nav group's label (`Pages` for an unlabelled one), `Settings`, `Quick links`. */
  group: string
  icon?: ComponentType<{ className?: string }>
  /** Extra words a search should match (a settings tab's contents, a quick link's description). */
  keywords?: readonly string[]
  /** `kit`, or the id of the plugin that contributed it. */
  source: string
}

/** The heading an unlabelled nav group gets in a list. */
export const UNLABELLED_NAV_GROUP = 'Pages'

export interface NavigationChecks {
  canAccess: (guard: NavGuard | undefined) => boolean
  /** The ability, for a plugin's `settingsTabs({ can })`. */
  can: (action: string, subject: string) => boolean
}

/** The list, pure: the plugins and the checks are passed in, so it is unit-tested directly. */
export function navigationEntries(
  plugins: readonly AnyUiPlugin[],
  { canAccess, can }: NavigationChecks
): NavigationEntry[] {
  const out: NavigationEntry[] = []
  const seen = new Set<string>()
  const add = (entry: NavigationEntry) => {
    if (seen.has(entry.to)) return
    seen.add(entry.to)
    out.push(entry)
  }

  // Nav: SideNav's own composition; provenance by item identity (composeNav keeps the objects).
  const owner = new Map<NavItem, string>()
  for (const p of plugins)
    for (const g of p.nav ?? []) for (const i of g.items) owner.set(i, p.shared.id)
  const nav = filterNavConfig(
    composeNav(
      CORE_NAVIGATION,
      plugins.flatMap(p => p.nav ?? [])
    ),
    canAccess
  )
  for (const node of nav) {
    const group = isNavGroup(node) ? (node.label ?? UNLABELLED_NAV_GROUP) : UNLABELLED_NAV_GROUP
    for (const item of isNavGroup(node) ? node.items : [node]) {
      add({
        id: `nav:${item.to}`,
        label: item.label,
        to: item.to,
        group,
        icon: item.icon,
        source: owner.get(item) ?? 'kit',
      })
    }
  }

  // Settings tabs, only for someone who may open the page at all.
  if (canAccess(SETTINGS_PAGE_GUARD)) {
    const settingsIcon = CORE_SETTINGS_TABS[0]?.icon
    for (const tab of CORE_SETTINGS_TABS) {
      if (!canAccess(tab.guard)) continue
      add({
        id: `settings:${tab.id}`,
        label: tab.label,
        to: settingsTabPath(tab.id),
        group: 'Settings',
        icon: tab.icon,
        keywords: ['settings', ...(tab.keywords ?? [])],
        source: 'kit',
      })
    }
    for (const p of plugins) {
      for (const tab of p.settingsTabs?.({ can }) ?? []) {
        add({
          id: `settings:${tab.id}`,
          label: tab.label,
          to: settingsTabPath(tab.id),
          group: 'Settings',
          ...(settingsIcon ? { icon: settingsIcon } : {}),
          keywords: ['settings'],
          source: p.shared.id,
        })
      }
    }
  }

  // Quick links: plugins' first, as Home shows them.
  const links = [
    ...plugins.flatMap(p => (p.homeLinks ?? []).map(l => ({ link: l, source: p.shared.id }))),
    ...CORE_QUICK_LINKS.map(l => ({ link: l, source: 'kit' })),
  ]
  for (const { link, source } of links) {
    if (!canAccess(link.guard)) continue
    add({
      id: `link:${link.to}`,
      label: link.label,
      to: link.to,
      group: 'Quick links',
      icon: link.icon,
      keywords: [link.description],
      source,
    })
  }
  return out
}

/** `navigationEntries` for the signed-in reader and the installed plugins. */
export function useNavigationEntries(): NavigationEntry[] {
  const canAccess = useNavGuard()
  const { can } = usePermissions()
  return useMemo(
    () =>
      navigationEntries(uiPlugins, {
        canAccess,
        can: (action, subject) => can(action as Actions, subject as Subjects),
      }),
    [canAccess, can]
  )
}
