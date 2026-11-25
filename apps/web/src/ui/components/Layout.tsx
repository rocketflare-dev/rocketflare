import { Bars3Icon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useEnvironmentTitle } from '@/ui/hooks/useEnvironmentTitle'
import { EnvironmentBadge } from './EnvironmentBadge'
import { ErrorBoundary } from './ErrorBoundary'
import SideNav from './SideNav'
import ThemeToggle from './ThemeToggle'

export interface LayoutProps {
  children: ReactNode
  /**
   * Left side of the top bar, after the hamburger: `<OrgSwitcher />`
   * (hidden when `TENANCY_MODE=single`).
   */
  headerStart?: ReactNode
  /**
   * Middle of the top bar: the shell puts the `center` plugin header items here
   * (`<PluginHeaderSlot placement="center" />`, a search box); empty without one.
   */
  headerCenter?: ReactNode
  /**
   * Right side of the top bar, before the theme toggle: the `end` plugin header items, then
   * `<NotificationsBell />`,
   * user dropdown (`<details>/<summary>` avatar → Profile / Settings / Sign out),
   * `<WebSocketStatus />`.
   */
  headerEnd?: ReactNode
  /** Rendered above the collapse toggle in the sidebar (e.g. tenant name, support banner). */
  sidebarFooter?: ReactNode
  /**
   * A plugin `workspace` route: the sidebar collapses to its icon rail, `<main>` has no padding
   * and the page exactly fills the viewport under the header, scrolling only its own panes.
   */
  workspace?: boolean
}

/**
 * Drawer shell: left `SideNav`, sticky top bar, `<main>` behind its own ErrorBoundary (a page
 * crash keeps the chrome; navigating resets it). Mounted ONCE under `/*` — see App.tsx.
 */
export default function Layout({
  children,
  headerStart,
  headerCenter,
  headerEnd,
  sidebarFooter,
  workspace = false,
}: LayoutProps) {
  const { pathname } = useLocation()
  useEnvironmentTitle()
  // Workspace pages size to the viewport; every other page grows it and the document scrolls.
  const height = workspace ? 'h-dvh' : 'min-h-screen'

  return (
    <div className={`drawer lg:drawer-open app-canvas ${height}`}>
      <input id="drawer-toggle" type="checkbox" className="drawer-toggle" />

      <div className={`drawer-content flex flex-col ${height}`}>
        <header className="app-header sticky top-0 z-30 flex items-center border-b px-3 gap-2 h-14">
          <label
            htmlFor="drawer-toggle"
            className="btn btn-ghost btn-sm btn-square lg:hidden"
            aria-label="Open navigation"
          >
            <Bars3Icon className="w-5 h-5" />
          </label>

          {headerStart}
          <EnvironmentBadge />

          <div className="flex-1 flex justify-start min-w-0">{headerCenter}</div>

          <div className="flex items-center gap-1.5">
            {headerEnd}
            <ThemeToggle />
          </div>
        </header>

        <main
          className={workspace ? 'flex min-h-0 flex-1 flex-col overflow-clip' : 'flex-1 p-4 md:p-8'}
        >
          <ErrorBoundary resetKeys={[pathname]}>{children}</ErrorBoundary>
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="drawer-toggle" aria-label="Close navigation" className="drawer-overlay" />
        <SideNav footer={sidebarFooter} forceCollapsed={workspace} />
      </div>
    </div>
  )
}
