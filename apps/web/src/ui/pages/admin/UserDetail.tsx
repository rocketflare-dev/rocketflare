/**
 * Admin → one user (D10): the global-admin flag and blocking (never on yourself), their
 * memberships, and linked sign-in providers.
 */
import { ArrowLeftIcon, UserIcon } from '@heroicons/react/24/outline'
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
import { useAdminUser, useBlockUser, useSetGlobalAdmin } from '@/ui/hooks/useAdminUsers'
import { useAuth } from '@/ui/hooks/useAuth'
import { formatDate, timeAgo } from '@/ui/lib/format'

export default function UserDetail() {
  const { id = '' } = useParams()
  const { user: me } = useAuth()
  const { data: user, isLoading } = useAdminUser(id)
  const setGlobalAdmin = useSetGlobalAdmin(id)
  const block = useBlockUser(id)
  const [confirm, setConfirm] = useState<'block' | 'grant' | null>(null)

  if (isLoading) return <SectionPanelSkeleton rows={4} />
  if (!user) return <EmptyState icon={UserIcon} message="User not found" />

  const isSelf = me?.id === user.id
  const blocked = user.blockedAt !== null

  return (
    <div className="space-y-4">
      <Link to="/admin/users" className="btn btn-ghost btn-xs -ml-2 gap-1">
        <ArrowLeftIcon className="w-3.5 h-3.5" /> All users
      </Link>
      <PageHeader
        title={user.name}
        badge={
          <>
            {user.isGlobalAdmin && <span className="badge badge-sm badge-info">global admin</span>}
            {blocked && <span className="badge badge-sm badge-error">blocked</span>}
          </>
        }
        description={
          <>
            {user.email} · joined {formatDate(user.createdAt)} · last signed in{' '}
            {timeAgo(user.lastLoginAt)}
            {isSelf && ' · this is you'}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className={`btn btn-sm ${user.isGlobalAdmin ? 'btn-outline' : 'btn-outline btn-info'}`}
              disabled={isSelf || setGlobalAdmin.isPending}
              title={isSelf ? "You can't change your own access" : undefined}
              onClick={() =>
                user.isGlobalAdmin ? setGlobalAdmin.mutate(false) : setConfirm('grant')
              }
            >
              {user.isGlobalAdmin ? 'Revoke global admin' : 'Make global admin'}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${blocked ? 'btn-success' : 'btn-outline btn-error'}`}
              disabled={isSelf || block.isPending}
              title={isSelf ? "You can't block yourself" : undefined}
              onClick={() => (blocked ? block.mutate(false) : setConfirm('block'))}
            >
              {blocked ? 'Unblock' : 'Block'}
            </button>
          </>
        }
      />

      <SectionPanel flush title={`Organisations (${user.memberships.length})`}>
        {user.memberships.length === 0 ? (
          <EmptyState message="Not a member of any organisation" size="sm" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Role</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {user.memberships.map(m => (
                  <tr key={m.tenantId}>
                    <td>
                      <Link
                        to={`/admin/tenants/${m.tenantId}`}
                        className="link link-hover font-medium"
                      >
                        {m.name}
                      </Link>
                      <div className="text-xs text-muted font-mono">@{m.slug}</div>
                    </td>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
                    <td className="text-secondary whitespace-nowrap">{formatDate(m.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <SectionPanel title="Sign-in methods">
        {user.providers.length === 0 ? (
          <p className="text-sm text-muted">Email link only — no OAuth provider linked.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {user.providers.map(p => (
              <li
                key={p.provider}
                className="badge badge-ghost capitalize"
                title={`Linked ${formatDate(p.createdAt)}`}
              >
                {p.provider}
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>

      <ConfirmModal
        isOpen={confirm === 'block'}
        title="Block user"
        message={`Block ${user.name}? They are signed out everywhere and cannot sign in again until unblocked.`}
        confirmText="Block"
        confirmButtonClass="btn-error"
        isLoading={block.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => block.mutate(true, { onSuccess: () => setConfirm(null) })}
      />
      <ConfirmModal
        isOpen={confirm === 'grant'}
        title="Make global admin"
        message={`Give ${user.name} access to every organisation on this deployment?`}
        confirmText="Grant"
        confirmButtonClass="btn-warning"
        isLoading={setGlobalAdmin.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => setGlobalAdmin.mutate(true, { onSuccess: () => setConfirm(null) })}
      />
    </div>
  )
}
