/**
 * Admin → one organisation: members, suspend/reinstate, and "enter as support" — which
 * adds a real `support` membership its owners can see in Settings → People, then switches in.
 * Under IdP-managed tenancy, also the issuer org it mirrors: linking a tenant made by hand whose
 * slug differs from the org's is what stops that org's first sign-in creating a second one. And deleting it, which an owner can do from
 * Settings but a tenant with no owner (any IdP-managed tenancy creates) needs an admin for.
 */
import {
  ArrowLeftIcon,
  BuildingOffice2Icon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { RoleBadge } from '@/ui/components/RoleBadge'
import {
  ConfirmModal,
  EmptyState,
  Modal,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import {
  useAdminDeleteTenant,
  useAdminTenant,
  useEnterSupport,
  useLeaveSupport,
  useSetTenantExternalOrg,
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

      {tenancyMode === 'multi' && (tenant.idpManaged || tenant.externalOrgId) && (
        <IssuerOrgPanel tenantId={tenant.id} externalOrgId={tenant.externalOrgId} />
      )}

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

      {tenancyMode === 'multi' && (
        <DeleteTenantPanel
          tenantId={tenant.id}
          name={tenant.name}
          slug={tenant.slug}
          linked={tenant.externalOrgId !== null}
        />
      )}

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

/** The issuer org this tenant mirrors: shown, linked, changed or unlinked. */
function IssuerOrgPanel({
  tenantId,
  externalOrgId,
}: {
  tenantId: string
  externalOrgId: string | null
}) {
  const link = useSetTenantExternalOrg(tenantId)
  const [draft, setDraft] = useState(externalOrgId ?? '')
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const value = draft.trim()
  const changed = value.length > 0 && value !== externalOrgId

  return (
    <SectionPanel title="Identity provider org">
      <p className="text-sm text-secondary mb-3">
        Sign-ins whose org claim names this id are reconciled into this organisation. An unlinked
        organisation whose slug is the org's is linked at the org's first sign-in; link one whose
        slug differs before its people sign in, or their first sign-in creates a second one. An id
        is linked to one organisation at a time: unlink the other first.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={e => {
          e.preventDefault()
          if (changed) link.mutate(value)
        }}
      >
        <input
          className="input input-sm w-96 max-w-full font-mono"
          aria-label="Identity provider org id"
          placeholder="Not linked"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={!changed || link.isPending}
        >
          {externalOrgId ? 'Change' : 'Link'}
        </button>
        {externalOrgId && (
          <button
            type="button"
            className="btn btn-sm btn-outline btn-error"
            disabled={link.isPending}
            onClick={() => setConfirmUnlink(true)}
          >
            Unlink
          </button>
        )}
      </form>
      <ConfirmModal
        isOpen={confirmUnlink}
        title="Unlink identity provider org"
        message="Unlink this organisation? Members who came from the identity provider leave it at their next sign-in, and a tenant linked to the org (or a new one) takes over."
        confirmText="Unlink"
        confirmButtonClass="btn-error"
        isLoading={link.isPending}
        onCancel={() => setConfirmUnlink(false)}
        onConfirm={() =>
          link.mutate(null, {
            onSuccess: () => {
              setConfirmUnlink(false)
              setDraft('')
            },
          })
        }
      />
    </SectionPanel>
  )
}

/** Delete the organisation for good, typing its slug to confirm. */
function DeleteTenantPanel({
  tenantId,
  name,
  slug,
  linked,
}: {
  tenantId: string
  name: string
  slug: string
  linked: boolean
}) {
  const remove = useAdminDeleteTenant(tenantId)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const matches = confirm.trim() === slug

  return (
    <SectionPanel
      title={<span className="text-error">Danger zone</span>}
      description="Deleting removes every member, invitation, key, record and stored file. There is no undo."
    >
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-secondary">Delete {name} permanently.</p>
        <button
          type="button"
          className="btn btn-error btn-sm btn-outline"
          onClick={() => setOpen(true)}
        >
          Delete organisation
        </button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${name}?`}
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOpen(false)}
              disabled={remove.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-error"
              disabled={!matches || remove.isPending}
              onClick={() => remove.mutate(confirm.trim())}
            >
              {remove.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Delete forever'
              )}
            </button>
          </>
        }
      >
        <div className="alert alert-warning text-sm mb-4" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
          <span>
            This cannot be undone. Every member loses access immediately.
            {linked &&
              ' It is linked to an identity provider org: the next sign-in with that org creates a new organisation unless you link another one to it.'}
          </span>
        </div>
        <label htmlFor="admin-delete-confirm" className="label text-sm">
          Type <code className="font-mono">{slug}</code> to confirm
        </label>
        <input
          id="admin-delete-confirm"
          className="input w-full font-mono"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="off"
        />
      </Modal>
    </SectionPanel>
  )
}
