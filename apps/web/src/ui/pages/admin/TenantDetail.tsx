/**
 * Admin → one organisation (D10, D25): members, suspend/reinstate, and "enter as support" — which
 * adds a real `support` membership its owners can see in Settings → People, then switches in.
 */
import { ArrowLeftIcon, BuildingOffice2Icon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { RoleBadge } from '@/ui/components/RoleBadge'
import {
  ConfirmModal,
  EmptyState,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import {
  useAdminTenant,
  useEnterSupport,
  useLeaveSupport,
  useSuspendTenant,
} from '@/ui/hooks/useAdminTenants'
import { useAuth } from '@/ui/hooks/useAuth'
import { formatDate, timeAgo } from '@/ui/lib/format'

export default function TenantDetail() {
  const { id = '' } = useParams()
  const { tenancyMode } = useAuth()
  const { data: tenant, isLoading } = useAdminTenant(id)
  const suspend = useSuspendTenant(id)
  const enter = useEnterSupport(id)
  const leave = useLeaveSupport(id)
  const [confirmSuspend, setConfirmSuspend] = useState(false)

  if (isLoading) return <SectionPanelSkeleton rows={4} />
  if (!tenant) return <EmptyState icon={BuildingOffice2Icon} message="Organisation not found" />

  const suspended = tenant.status === 'suspended'

  return (
    <div className="space-y-4">
      {tenancyMode === 'multi' && (
        <Link to="/admin/tenants" className="btn btn-ghost btn-xs -ml-2 gap-1">
          <ArrowLeftIcon className="w-3.5 h-3.5" /> All organisations
        </Link>
      )}
      <PageHeader
        title={tenant.name}
        badge={
          suspended ? (
            <span className="badge badge-sm badge-error">suspended</span>
          ) : (
            <span className="badge badge-sm badge-success">active</span>
          )
        }
        description={
          <>
            <span className="font-mono">@{tenant.slug}</span> · {tenant.memberCount} member
            {tenant.memberCount === 1 ? '' : 's'} · created {formatDate(tenant.createdAt)} · last
            active {timeAgo(tenant.lastAccessedAt)}
          </>
        }
        actions={
          <>
            {tenant.supportAccess ? (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                disabled={leave.isPending}
                onClick={() => leave.mutate()}
              >
                Leave support access
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={enter.isPending}
                onClick={() => enter.mutate()}
              >
                Enter as support
              </button>
            )}
            <button
              type="button"
              className={`btn btn-sm ${suspended ? 'btn-success' : 'btn-outline btn-error'}`}
              disabled={suspend.isPending}
              onClick={() => (suspended ? suspend.mutate(false) : setConfirmSuspend(true))}
            >
              {suspended ? 'Reinstate' : 'Suspend'}
            </button>
          </>
        }
      />

      <SectionPanel flush title={`Members (${tenant.members.length})`}>
        {tenant.members.length === 0 ? (
          <EmptyState message="No members" size="sm" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {tenant.members.map(m => (
                  <tr key={m.userId}>
                    <td>
                      <Link to={`/admin/users/${m.userId}`} className="link link-hover font-medium">
                        {m.name}
                      </Link>
                      <div className="text-xs text-secondary">{m.email}</div>
                    </td>
                    <td className="space-x-1">
                      <RoleBadge role={m.role} />
                      {m.isGlobalAdmin && (
                        <span className="badge badge-sm badge-info">global admin</span>
                      )}
                      {m.blockedAt && <span className="badge badge-sm badge-error">blocked</span>}
                    </td>
                    <td className="text-secondary whitespace-nowrap">{formatDate(m.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <ConfirmModal
        isOpen={confirmSuspend}
        title="Suspend organisation"
        message={`Suspend ${tenant.name}? Every member's API access stops until it is reinstated.`}
        confirmText="Suspend"
        confirmButtonClass="btn-error"
        isLoading={suspend.isPending}
        onCancel={() => setConfirmSuspend(false)}
        onConfirm={() => suspend.mutate(true, { onSuccess: () => setConfirmSuspend(false) })}
      />
    </div>
  )
}
