/**
 * Navigation outside React Router (D20). `AuthProvider` sits ABOVE `BrowserRouter` (06 §b), so the
 * global 401 handler cannot call `useNavigate()`; `<NavigationBridge />` (mounted inside the router)
 * registers the router's `navigate` and current location here. `hardNavigate` wraps
 * `window.location.assign` so tests can stub it (jsdom cannot navigate) and so full-page
 * transitions — OAuth, dev-login — are greppable.
 */
import { useEffect } from 'react'
import { type NavigateFunction, useLocation, useNavigate } from 'react-router-dom'

let routerNavigate: NavigateFunction | null = null
let routerPath: string | null = null

/** Mount once inside the router. */
export function NavigationBridge() {
  const navigate = useNavigate()
  const location = useLocation()
  routerPath = location.pathname + location.search
  useEffect(() => {
    routerNavigate = navigate
    return () => {
      routerNavigate = null
      routerPath = null
    }
  }, [navigate])
  return null
}

/** Client-side navigation when the router is mounted; full-page fallback otherwise. */
export function navigateTo(to: string, options: { replace?: boolean } = {}): void {
  if (routerNavigate) routerNavigate(to, { replace: options.replace ?? false })
  else hardNavigate(to)
}

/** Full-page navigation — the server sets/clears the cookie and every cache starts clean. */
export function hardNavigate(url: string): void {
  window.location.assign(url)
}

/** `/settings/people?tab=x` — the current in-app location (router's when mounted). */
export function currentPath(): string {
  return routerPath ?? window.location.pathname + window.location.search
}

export function currentPathname(): string {
  return currentPath().split('?')[0]
}

/** Only same-origin relative paths are honoured (open-redirect guard, mirrors `redirectToSchema`). */
export function safeReturnUrl(value: string | null | undefined, fallback = '/'): string {
  if (!value) return fallback
  return /^\/(?![/\\])/.test(value) ? value : fallback
}

export function loginUrl(returnUrl?: string): string {
  const target = returnUrl ?? currentPath()
  if (!target || target === '/' || target.startsWith('/login')) return '/login'
  return `/login?returnUrl=${encodeURIComponent(target)}`
}
