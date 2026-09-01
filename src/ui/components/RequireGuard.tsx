import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { type NavGuard, useNavGuard } from '@/ui/hooks/useNavGuard'

interface RequireGuardProps {
  guard: NavGuard
  children: ReactNode
  /** Where to send a reader who fails the guard (default: home) */
  redirectTo?: string
}

/**
 * Route-level twin of the SideNav `guard` flag — the same `useNavGuard()` decides both, so a
 * visible link always leads to an openable page. Cosmetic only: the server enforces.
 *
 * Phase 1: `ProtectedRoute` (session + tenant) wraps the whole shell; this wraps sections:
 *   <Route path="settings/*" element={<RequireGuard guard="admin"><SettingsLayout/></RequireGuard>} />
 */
export function RequireGuard({ guard, children, redirectTo = '/' }: RequireGuardProps) {
  const canAccess = useNavGuard()
  if (!canAccess(guard)) return <Navigate to={redirectTo} replace />
  return <>{children}</>
}
