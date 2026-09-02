/**
 * Session gate for the app shell (D9, D20). Unauthenticated → `/login?returnUrl=`; signed in but
 * in no organisation → the `noTenantRoute` rule (pending / select-tenant / no-access). Pages that
 * must render WITHOUT a tenant (those three) pass `requireTenant={false}`. One exemption: a global
 * admin may open `/admin/*` with no membership at all (`isAdminPath`) — otherwise the bootstrap
 * admin of an invite-only deployment could never approve anyone (SETUP.md 2.4). Cosmetic — the
 * server enforces on every request (`/api/admin/*` is tenant-free by design).
 */
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { noTenantRoute, useAuth } from '@/ui/hooks/useAuth'
import { loginUrl } from '@/ui/lib/navigation'
import { LoadingIndicator } from './LoadingIndicator'

interface ProtectedRouteProps {
  children: ReactNode
  /** Default true: also require an active tenant */
  requireTenant?: boolean
}

/** `/admin` and everything beneath it — the cross-tenant area that needs no membership. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

export function ProtectedRoute({ children, requireTenant = true }: ProtectedRouteProps) {
  const { status, session, error, refresh } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <LoadingIndicator size="lg" centered />

  if (status === 'unauthenticated') {
    if (error) return <SessionUnavailable error={error} onRetry={refresh} />
    return <Navigate to={loginUrl(location.pathname + location.search)} replace />
  }

  if (requireTenant && session && !session.tenant) {
    if (session.user.isGlobalAdmin && isAdminPath(location.pathname)) return <>{children}</>
    const target = noTenantRoute(session)
    if (location.pathname !== target) return <Navigate to={target} replace />
  }

  return <>{children}</>
}

/** The session request failed for a reason other than "not signed in" — offer a retry. */
function SessionUnavailable({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="min-h-screen main-gradient flex items-center justify-center p-6">
      <div className="surface-panel max-w-md w-full text-center">
        <h2 className="text-lg font-semibold mb-1">Can't reach the server</h2>
        <p className="text-sm text-secondary mb-4">
          {import.meta.env.DEV ? error.message : 'Please check your connection and try again.'}
        </p>
        <button type="button" className="btn btn-sm btn-primary gap-1.5" onClick={onRetry}>
          <ArrowPathIcon className="w-4 h-4" />
          Retry
        </button>
      </div>
    </div>
  )
}

export default ProtectedRoute
