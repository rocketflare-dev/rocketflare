/**
 * Decide an access request (D9, D25). Approve = join an existing organisation (picker from
 * `/api/admin/tenants`, role) or create a new one owned by the requester — the latter hidden when
 * `tenancyMode === 'single'`. Reject = optional reason. Both post `decideAccessRequestSchema`.
 */
import { type AccessRequest, decideAccessRequestSchema } from '@gmgo/shared/access-requests'
import { slugify, type TenantRole, tenantRoleSchema } from '@gmgo/shared/tenants'
import { useState } from 'react'
import { FieldError, fieldErrorFor, Modal } from '@/ui/components/shared'
import { useDecideAccessRequest } from '@/ui/hooks/useAdminAccessRequests'
import { useAdminTenants } from '@/ui/hooks/useAdminTenants'
import { useAuth } from '@/ui/hooks/useAuth'

type Issues = { path: PropertyKey[]; message: string }[] | undefined

export function ApproveRequestModal({
  request,
  onClose,
}: {
  request: AccessRequest
  onClose: () => void
}) {
  const { tenancyMode } = useAuth()
  const decide = useDecideAccessRequest()
  const { data: orgs } = useAdminTenants({ pageSize: 200, status: 'active' })
  const organisations = orgs?.items ?? []
  const allowNewOrg = tenancyMode === 'multi'

  const [mode, setMode] = useState<'join' | 'new_org'>('join')
  const [tenantId, setTenantId] = useState(request.requestedTenantId ?? '')
  const [role, setRole] = useState<TenantRole>('member')
  const [name, setName] = useState(`${request.email.split('@')[0]}'s organisation`)
  const [issues, setIssues] = useState<Issues>()

  const effectiveTenantId = tenantId || organisations[0]?.id || ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const approve =
      mode === 'join'
        ? { mode: 'join' as const, tenantId: effectiveTenantId, role }
        : { mode: 'new_org' as const, name, slug: slugify(name) }
    const parsed = decideAccessRequestSchema.safeParse({ decision: 'approve', approve })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    decide.mutate({ id: request.id, decision: parsed.data }, { onSuccess: onClose })
  }

  const approveIssue = (field: string) =>
    issues?.find(i => i.path[0] === 'approve' && i.path[1] === field)?.message

  return (
    <Modal
      open
      onClose={onClose}
      title={`Approve ${request.email}`}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={decide.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="approve-form"
            className="btn btn-sm btn-primary"
            disabled={decide.isPending}
          >
            {decide.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Approve'}
          </button>
        </>
      }
    >
      <form id="approve-form" onSubmit={submit} className="space-y-4" noValidate>
        {allowNewOrg && (
          <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
            <button
              type="button"
              role="tab"
              className={`tab ${mode === 'join' ? 'tab-active' : ''}`}
              onClick={() => setMode('join')}
            >
              Join an organisation
            </button>
            <button
              type="button"
              role="tab"
              className={`tab ${mode === 'new_org' ? 'tab-active' : ''}`}
              onClick={() => setMode('new_org')}
            >
              New organisation
            </button>
          </div>
        )}

        {mode === 'join' ? (
          <>
            <div>
              <label htmlFor="approve-tenant" className="label text-sm">
                Organisation
              </label>
              <select
                id="approve-tenant"
                className="select w-full"
                value={effectiveTenantId}
                onChange={e => setTenantId(e.target.value)}
              >
                {organisations.length === 0 && <option value="">No organisations</option>}
                {organisations.map(org => (
                  <option key={org.id} value={org.id}>
                    {org.name} (@{org.slug})
                  </option>
                ))}
              </select>
              <FieldError message={approveIssue('tenantId')} />
            </div>
            <div>
              <label htmlFor="approve-role" className="label text-sm">
                Role
              </label>
              <select
                id="approve-role"
                className="select w-full capitalize"
                value={role}
                onChange={e => setRole(e.target.value as TenantRole)}
              >
                {tenantRoleSchema.options.map(r => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div>
            <label htmlFor="approve-org-name" className="label text-sm">
              Organisation name
            </label>
            <input
              id="approve-org-name"
              className="input w-full"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <p className="text-xs text-muted mt-1">
              They become its owner. Slug: <code className="font-mono">{slugify(name)}</code>
            </p>
            <FieldError message={approveIssue('name') ?? approveIssue('slug')} />
          </div>
        )}
        <FieldError message={fieldErrorFor(issues, 'decision')} />
      </form>
    </Modal>
  )
}

export function RejectRequestModal({
  request,
  onClose,
}: {
  request: AccessRequest
  onClose: () => void
}) {
  const decide = useDecideAccessRequest()
  const [reason, setReason] = useState('')
  const [issues, setIssues] = useState<Issues>()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = decideAccessRequestSchema.safeParse({
      decision: 'reject',
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    decide.mutate({ id: request.id, decision: parsed.data }, { onSuccess: onClose })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${request.email}`}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={decide.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="reject-form"
            className="btn btn-sm btn-error"
            disabled={decide.isPending}
          >
            {decide.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Reject'}
          </button>
        </>
      }
    >
      <form id="reject-form" onSubmit={submit} noValidate>
        <label htmlFor="reject-reason" className="label text-sm">
          Reason <span className="text-muted">(optional, kept for the record)</span>
        </label>
        <textarea
          id="reject-reason"
          className="textarea w-full"
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <FieldError message={fieldErrorFor(issues, 'reason')} />
      </form>
    </Modal>
  )
}
