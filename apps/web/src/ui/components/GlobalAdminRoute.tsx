/**
 * Gates the cross-tenant /admin area on `users.isGlobalAdmin` (D10). Cosmetic — the real
 * enforcement is the global-admin middleware on `/api/admin/*`.
 */
import type { ReactNode } from 'react'
import { RequireGuard } from './RequireGuard'

export function GlobalAdminRoute({ children }: { children: ReactNode }) {
  return <RequireGuard guard="globalAdmin">{children}</RequireGuard>
}

export default GlobalAdminRoute
