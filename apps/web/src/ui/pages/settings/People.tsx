/**
 * Settings → People (D10): members (role select, remove) and pending invitations (resend, revoke),
 * plus the invite modal (one address, or a bulk paste). Who may do what:
 *   - `manage TenantMember` (admin+) → change roles, remove, invite
 *   - explicit `role === 'owner'` (or global admin) → touch owner rows / assign owner
 *   - `support` rows are read-only (not an assignable role)
 * Invitation "copy link" appears only when the server includes a `token` on the row.
 */

import {
  ClipboardIcon,
  EnvelopeIcon,
  UserGroupIcon,
  UserPlusIcon,
} from '@heroicons/react/24/outline'
import { type Member, type TenantRole, tenantRoleSchema } from '@rocketflare/shared/tenants'
import { useState } from 'react'
import { RoleBadge } from '@/ui/components/RoleBadge'
import {
  ConfirmModal,
  EmptyState,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  showToast,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useInvitations, useResendInvitation, useRevokeInvitation } from '@/ui/hooks/useInvitations'
import { useMembers, useRemoveMember, useUpdateMemberRole } from '@/ui/hooks/useMembers'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { formatDate, timeAgo } from '@/ui/lib/format'
import { InviteModal } from './InviteModal'

const ASSIGNABLE_ROLES = tenantRoleSchema.options

export default function People() {
  const [inviteOpen, setInviteOpen] = useState(false)
  const { can } = usePermissions()
  const canManage = can('manage', 'TenantMember')

  return (
    <div className="space-y-4">
      <MembersPanel onInvite={canManage ? () => setInviteOpen(true) : undefined} />
      <InvitationsPanel />
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  )
}

function MembersPanel({ onInvite }: { onInvite?: () => void }) {
  const { user, tenant, isGlobalAdmin } = useAuth()
  const { can } = usePermissions()
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useMembers({ page })
  const updateRole = useUpdateMemberRole()
  const removeMember = useRemoveMember()
  const [removing, setRemoving] = useState<Member | null>(null)

  const canManage = can('manage', 'TenantMember')
  const canManageOwners = tenant?.role === 'owner' || isGlobalAdmin
  const members = data?.items ?? []

  const roleLocked = (m: Member) =>
    !canManage ||
    m.userId === user?.id ||
    (m.role === 'owner' && !canManageOwners) ||
    !(ASSIGNABLE_ROLES as readonly string[]).includes(m.role)

  const canRemove = (m: Member) =>
    canManage && m.userId !== user?.id && m.role !== 'owner' && m.role !== 'support'

  return (
    <SectionPanel
      flush
      title="Members"
      description={
        data
          ? `${data.pagination.total} ${data.pagination.total === 1 ? 'person' : 'people'}`
          : undefined
      }
      actions={
        onInvite && (
          <button type="button" className="btn btn-primary btn-sm gap-1.5" onClick={onInvite}>
            <UserPlusIcon className="w-4 h-4" />
            Invite
          </button>
        )
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={4} />
        </div>
      ) : members.length === 0 ? (
        <EmptyState icon={UserGroupIcon} message="No members yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Last sign-in</th>
                {canManage && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.userId}>
                  <td>
                    <div className="font-medium">
                      {m.name}
                      {m.userId === user?.id && (
                        <span className="ml-2 text-xs text-muted">(you)</span>
                      )}
                    </div>
                    <div className="text-xs text-secondary">{m.email}</div>
                  </td>
                  <td>
                    {roleLocked(m) ? (
                      <RoleBadge role={m.role} />
                    ) : (
                      <select
                        className="select select-xs capitalize"
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        disabled={updateRole.isPending}
                        onChange={e =>
                          updateRole.mutate({
                            userId: m.userId,
                            role: e.target.value as TenantRole,
                          })
                        }
                      >
                        {ASSIGNABLE_ROLES.filter(r => r !== 'owner' || canManageOwners).map(r => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="text-secondary whitespace-nowrap">{formatDate(m.joinedAt)}</td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(m.lastLoginAt)}</td>
                  {canManage && (
                    <td className="text-right">
                      {canRemove(m) && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => setRemoving(m)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={data.pagination}
            onPageChange={setPage}
            isLoading={isFetching}
          />
        </div>
      )}
      <ConfirmModal
        isOpen={removing !== null}
        title="Remove member"
        message={`Remove ${removing?.name ?? ''} from ${tenant?.name ?? 'this organisation'}? They lose access immediately.`}
        confirmText="Remove"
        confirmButtonClass="btn-error"
        isLoading={removeMember.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) removeMember.mutate(removing.userId, { onSuccess: () => setRemoving(null) })
        }}
      />
    </SectionPanel>
  )
}

function InvitationsPanel() {
  const { can } = usePermissions()
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useInvitations({ page })
  const resend = useResendInvitation()
  const revoke = useRevokeInvitation()
  const canManage = can('manage', 'Invitation')
  const items = (data?.items ?? []).filter(i => i.status === 'pending')

  const copyLink = async (token: string) => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/invite/${encodeURIComponent(token)}`
    )
    showToast('Invite link copied', 'success')
  }

  return (
    <SectionPanel flush title="Pending invitations">
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={2} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={EnvelopeIcon} message="No pending invitations" size="sm" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Invited by</th>
                <th>Expires</th>
                {canManage && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map(invite => {
                const token =
                  'token' in invite && typeof invite.token === 'string' ? invite.token : null
                return (
                  <tr key={invite.id}>
                    <td className="font-medium">{invite.email}</td>
                    <td>
                      <RoleBadge role={invite.role} />
                    </td>
                    <td className="text-secondary">{invite.invitedByName ?? '—'}</td>
                    <td className="text-secondary whitespace-nowrap">
                      {formatDate(invite.expiresAt)}
                    </td>
                    {canManage && (
                      <td className="text-right whitespace-nowrap">
                        {token && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs gap-1"
                            onClick={() => copyLink(token)}
                          >
                            <ClipboardIcon className="w-3.5 h-3.5" /> Copy link
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={resend.isPending}
                          onClick={() => resend.mutate(invite.id)}
                        >
                          Resend
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(invite.id)}
                        >
                          Revoke
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={data.pagination}
            onPageChange={setPage}
            isLoading={isFetching}
          />
        </div>
      )}
    </SectionPanel>
  )
}
