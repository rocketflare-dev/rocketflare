import {
  BookOpenIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType, ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { useBooleanPreference } from '@/ui/hooks/useLocalStoragePreference'
import { type NavBadgeKey, type NavBadges, useNavBadges } from '@/ui/hooks/useNavBadges'
import { type NavGuard, useNavGuard } from '@/ui/hooks/useNavGuard'
import { EXAMPLE_FEATURE } from '@/ui/lib/feature-guards'
import { LogoMark } from './shared/LogoMark'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** Hidden unless `useNavGuard()` allows it. Same mechanism as `RequireGuard` on the route. */
  guard?: NavGuard
  /** Optional count after the label */
  badge?: number
  /**
   * A live count resolved by `useNavBadges()` (issue #17). Declared here rather than fetched here
   * so `navigationConfig` stays plain data and `filterNavConfig` stays a pure function.
   */
  badgeKey?: NavBadgeKey
  /** `warning` for "something is waiting on you"; omitted for a quiet count. */
  badgeTone?: 'warning'
}

export interface NavGroup {
  label?: string
  items: NavItem[]
}

export type NavConfig = (NavItem | NavGroup)[]

/**
 * The kit's navigation (D10: each `guard` is the SAME flag the route uses). Profile and
 * Notifications live in the header `UserMenu`; apps add their own groups above "Organisation".
 */
export const navigationConfig: NavConfig = [
  {
    items: [
      { to: '/', label: 'Home', icon: HomeIcon },
      // D19: dashboards are tenant-shared; every member may read them (admins edit)
      {
        to: '/analytics',
        label: 'Analytics',
        icon: ChartBarIcon,
        guard: { action: 'read', subject: 'Analytics' },
      },
      // D17: every role may chat (ownership is the route's userId filter)
      {
        to: '/chat',
        label: 'Chat',
        icon: ChatBubbleLeftRightIcon,
        guard: { action: 'read', subject: 'Conversation' },
      },
      // D7: every role may start the example agent; members see their own runs
      // The badge counts the asks waiting on THIS person (issue #17) and is fed by a nudge, never
      // a poll. It is warning-toned because a parked agent is blocked until somebody answers.
      {
        to: '/agents',
        label: 'Agents',
        icon: CpuChipIcon,
        guard: { action: 'read', subject: 'AgentRun' },
        badgeKey: 'agentsAwaiting',
        badgeTone: 'warning',
      },
      // D18: the knowledge base is tenant-shared; every member may read and search
      {
        to: '/documents',
        label: 'Knowledge',
        icon: BookOpenIcon,
        guard: { action: 'read', subject: 'Document' },
      },
      {
        to: '/search',
        label: 'Search',
        icon: MagnifyingGlassIcon,
        guard: { action: 'read', subject: 'Document' },
      },
      // D30: the kit's demonstration flag. `EXAMPLE_FEATURE` is a `{ feature }` guard, so this item
      // is hidden for EVERYONE — global admins included — until the flag is on for the session's
      // organisation. That is the difference between a flag and a permission, and it is the whole
      // point of the demo: delete this item and its key when you add a real feature.
      {
        to: '/example-feature',
        label: 'Example feature',
        icon: SparklesIcon,
        guard: EXAMPLE_FEATURE,
      },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { to: '/settings', label: 'Settings', icon: Cog6ToothIcon, guard: 'admin' },
      { to: '/activity', label: 'Activity', icon: ClockIcon, guard: 'admin' },
    ],
  },
  {
    label: 'Platform',
    items: [{ to: '/admin', label: 'Admin', icon: ShieldCheckIcon, guard: 'globalAdmin' }],
  },
]

function isNavGroup(item: NavItem | NavGroup): item is NavGroup {
  return 'items' in item
}

/** Apply `canAccess` to every item and drop groups that end up empty. Pure — unit-testable. */
export function filterNavConfig(
  config: NavConfig,
  canAccess: (guard: NavGuard | undefined) => boolean
): NavConfig {
  return config
    .map(item =>
      isNavGroup(item) ? { ...item, items: item.items.filter(i => canAccess(i.guard)) } : item
    )
    .filter(item => (isNavGroup(item) ? item.items.length > 0 : canAccess(item.guard)))
}

/** `/` matches only itself; every other path matches itself and its descendants. */
export function isPathActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/'
  return pathname === to || pathname.startsWith(`${to}/`)
}

/** Close the mobile drawer after navigating (the desktop drawer is always open). */
function closeMobileDrawer() {
  const toggle = document.getElementById('drawer-toggle') as HTMLInputElement | null
  if (toggle && window.innerWidth < 1024) toggle.checked = false
}

interface SideNavProps {
  /** Overrides the default config (tests, apps composing their own nav) */
  items?: NavConfig
  /** Rendered above the collapse toggle */
  footer?: ReactNode
}

/** The count an item shows: its live `badgeKey` first, then whatever it declared statically. */
export function badgeValueFor(item: NavItem, badges: NavBadges): number | undefined {
  if (item.badgeKey !== undefined) {
    const live = badges[item.badgeKey]
    if (live !== undefined) return live
  }
  return item.badge
}

export default function SideNav({ items = navigationConfig, footer }: SideNavProps) {
  const { pathname } = useLocation()
  const canAccess = useNavGuard()
  const { name, version } = useAppInfo()
  const badges = useNavBadges()
  const [isCollapsed, setIsCollapsed] = useBooleanPreference('sideNavCollapsed', false)

  const visible = filterNavConfig(items, canAccess)

  const renderItem = (item: NavItem) => {
    const badge = badgeValueFor(item, badges)
    const warn = item.badgeTone === 'warning'
    return (
      <div key={item.to} className="relative group">
        <NavLink
          to={item.to}
          onClick={closeMobileDrawer}
          data-active={isPathActive(pathname, item.to)}
          className={`nav-item flex items-center gap-2.5 ${
            isCollapsed ? 'justify-center px-3 py-2.5' : 'px-2.5 py-1.5'
          }`}
        >
          <span className="relative flex-shrink-0">
            <item.icon className="w-[18px] h-[18px]" />
            {/* Collapsed, the count has nowhere to go — so it becomes a dot on the icon. Without
              this the whole feature is invisible to everyone who collapsed the sidebar. */}
            {isCollapsed && badge !== undefined && (
              <span
                data-testid={`nav-badge-dot-${item.badgeKey ?? item.to}`}
                className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${
                  warn ? 'bg-warning' : 'bg-primary'
                }`}
                aria-hidden="true"
              />
            )}
          </span>
          {!isCollapsed && <span className="flex-1">{item.label}</span>}
          {!isCollapsed && badge !== undefined && (
            <span
              className={`text-xs tabular-nums ${
                warn ? 'badge badge-warning badge-sm' : 'text-muted'
              }`}
            >
              {badge}
            </span>
          )}
          {badge !== undefined && (
            <span className="sr-only">{warn ? `${badge} waiting for you` : `${badge} items`}</span>
          )}
        </NavLink>
        {isCollapsed && (
          <div className="hidden md:block absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
            <div className="popover-surface px-3 py-2 text-sm whitespace-nowrap">
              {item.label}
              {badge !== undefined && <span className="ml-1.5 text-muted">{badge}</span>}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className={`app-nav h-full text-base-content border-r flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* Brand — bottom border lines up with the top bar's so the chrome seam is continuous */}
      <div
        className={`flex items-center gap-2.5 h-14 px-4 border-b border-[color:var(--border-default)] ${
          isCollapsed ? 'justify-center' : ''
        }`}
      >
        <Link to="/" className="flex items-center gap-2.5 truncate" aria-label={name}>
          <LogoMark />
          {!isCollapsed && (
            <span className="text-sm font-semibold tracking-tight text-base-content truncate">
              {name}
            </span>
          )}
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main">
        {visible.map(item => {
          if (isNavGroup(item)) {
            return (
              <div key={item.label ?? item.items[0]?.to}>
                {!isCollapsed && item.label && (
                  <div className="nav-group-label px-2.5 pb-1.5">{item.label}</div>
                )}
                <div className="space-y-0.5">{item.items.map(renderItem)}</div>
              </div>
            )
          }
          return renderItem(item)
        })}

        {/* Deployed release (RELEASE_VERSION via /api/health) — quiet, end of the nav */}
        {version && !isCollapsed && (
          <div className="px-2.5 pt-4 text-[11px] font-mono text-muted" title="Deployed release">
            v{version}
          </div>
        )}
      </nav>

      {footer && (
        <div className="px-3 py-2 border-t border-[color:var(--border-subtle)]">{footer}</div>
      )}

      <div className="p-3 hidden lg:block border-t border-[color:var(--border-subtle)]">
        <button
          type="button"
          onClick={() => setIsCollapsed(c => !c)}
          className={`btn btn-ghost btn-sm w-full ${isCollapsed ? 'btn-square' : 'justify-start gap-2'}`}
          title={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {isCollapsed ? (
            <ChevronRightIcon className="w-4 h-4" />
          ) : (
            <>
              <ChevronLeftIcon className="w-4 h-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
