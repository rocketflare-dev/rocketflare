/**
 * Coarse role gate for tenant settings (D10): owner, admin, support, or a global admin. The same
 * `'admin'` guard the SideNav uses — see `useNavGuard`. Cosmetic; the server enforces.
 */
import type { ReactNode } from 'react'
import { RequireGuard } from './RequireGuard'

export function AdminRoute({ children }: { children: ReactNode }) {
  return <RequireGuard guard="admin">{children}</RequireGuard>
}

export default AdminRoute
