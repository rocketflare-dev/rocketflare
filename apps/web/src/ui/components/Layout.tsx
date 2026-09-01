import { Bars3Icon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useEnvironmentTitle } from '@/ui/hooks/useEnvironmentTitle'
import { EnvironmentBadge } from './EnvironmentBadge'
import { ErrorBoundary } from './ErrorBoundary'
import SideNav from './SideNav'
import ThemeToggle from './ThemeToggle'

export interface LayoutProps {
  children: ReactNode
  /**
   * Left side of the top bar, after the hamburger. Phase 1: `<OrgSwitcher />`
   * (hidden when `TENANCY_MODE=single`, D25).
   */
  headerStart?: ReactNode
  /** Middle of the top bar — a documented slot, deliberately empty in the kit. */
  headerCenter?: ReactNode
  /**
   * Right side of the top bar, before the theme toggle. Phase 1: `<NotificationsBell />`,
   * user dropdown (`<details>/<summary>` avatar → Profile / Settings / Sign out); Phase 2:
   * `<WebSocketStatus />`.
   */
  headerEnd?: ReactNode
  /** Rendered above the collapse toggle in the sidebar (e.g. tenant name, support banner). */
  sidebarFooter?: ReactNode
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
}: LayoutProps) {
  const { pathname } = useLocation()
  useEnvironmentTitle()

  return (
    <div className="drawer lg:drawer-open min-h-screen app-canvas">
      <input id="drawer-toggle" type="checkbox" className="drawer-toggle" />

      <div className="drawer-content flex flex-col min-h-screen">
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

        <main className="flex-1 p-4 md:p-8">
          <ErrorBoundary resetKeys={[pathname]}>{children}</ErrorBoundary>
        </main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="drawer-toggle" aria-label="Close navigation" className="drawer-overlay" />
        <SideNav footer={sidebarFooter} />
      </div>
    </div>
  )
}
