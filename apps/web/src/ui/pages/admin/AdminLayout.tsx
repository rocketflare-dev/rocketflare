/**
 * `/admin/*` (D10, D25): the cross-tenant area, gated by `RequireGuard guard="globalAdmin"` on
 * the route (server: global-admin middleware). Sub-navigation as tabs with a pending-requests
 * count; in single mode "Organisations" collapses to the one tenant (see TenantList).
 */
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/ui/components/shared'
import { useAdminAccessRequests } from '@/ui/hooks/useAdminAccessRequests'
import { useAuth } from '@/ui/hooks/useAuth'

export default function AdminLayout() {
  const { tenancyMode } = useAuth()
  const { data } = useAdminAccessRequests({ status: 'pending', pageSize: 1 })
  const pendingCount = data?.pagination.total ?? 0

  const tabs = [
    { to: '/admin/access-requests', label: 'Access requests', badge: pendingCount },
    { to: '/admin/tenants', label: tenancyMode === 'single' ? 'Organisation' : 'Organisations' },
    { to: '/admin/users', label: 'Users' },
  ]

  return (
    <div className="max-w-5xl">
      <PageHeader title="Admin" description="Across every organisation on this deployment." />
      <div
        role="tablist"
        className="tabs tabs-border border-b border-[color:var(--border-default)] mb-6"
      >
        {tabs.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            className={({ isActive }) => `tab gap-2 ${isActive ? 'tab-active font-semibold' : ''}`}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="badge badge-sm badge-warning tabular-nums">{tab.badge}</span>
            )}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  )
}
