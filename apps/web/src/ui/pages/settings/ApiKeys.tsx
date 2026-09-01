/**
 * Settings → API keys (D12): list (prefix only), create (`createApiKeyRequestSchema`) — the
 * plaintext is shown ONCE in the modal with a copy button and never again — and revoke.
 */

import { ClipboardIcon, KeyIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  type ApiKey,
  type ApiKeyScope,
  apiKeyScopeSchema,
  createApiKeyRequestSchema,
} from '@rocketflare/shared/api-keys'
import { useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  FieldError,
  fieldErrorFor,
  Modal,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
  showToast,
} from '@/ui/components/shared'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/ui/hooks/useApiKeys'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { formatDate, timeAgo } from '@/ui/lib/format'

export default function ApiKeys() {
  const { can } = usePermissions()
  const canManage = can('manage', 'ApiKey')
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useApiKeys({ page })
  const revoke = useRevokeApiKey()
  const [createOpen, setCreateOpen] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const keys = data?.items ?? []

  return (
    <SectionPanel
      flush
      title="API keys"
      description="Authenticate scripts and integrations with Authorization: Bearer <key>."
      actions={
        canManage && (
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="w-4 h-4" />
            Create key
          </button>
        )
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyIcon}
          message="No API keys yet"
          description="Create one to call the API from outside the browser."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                {canManage && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const revoked = key.revokedAt !== null
                const expired = key.expiresAt !== null && key.expiresAt < new Date()
                return (
                  <tr key={key.id} className={revoked ? 'opacity-60' : ''}>
                    <td className="font-medium">{key.name}</td>
                    <td className="font-mono text-xs">{key.keyPrefix}…</td>
                    <td className="text-secondary text-xs">{key.scopes.join(', ')}</td>
                    <td className="text-secondary whitespace-nowrap">
                      {formatDate(key.createdAt)}
                    </td>
                    <td className="text-secondary whitespace-nowrap">{timeAgo(key.lastUsedAt)}</td>
                    <td className="text-secondary whitespace-nowrap">
                      {formatDate(key.expiresAt, 'never')}
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm ${revoked ? 'badge-ghost' : expired ? 'badge-warning' : 'badge-success'}`}
                      >
                        {revoked ? 'revoked' : expired ? 'expired' : 'active'}
                      </span>
                    </td>
                    {canManage && (
                      <td className="text-right">
                        {!revoked && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs text-error"
                            onClick={() => setRevoking(key)}
                          >
                            Revoke
                          </button>
                        )}
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

      <CreateKeyModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmModal
        isOpen={revoking !== null}
        title="Revoke API key"
        message={`Revoke "${revoking?.name ?? ''}"? Requests using it stop working immediately.`}
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
        }}
      />
    </SectionPanel>
  )
}

function CreateKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateApiKey()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read', 'write'])
  const [expiresAt, setExpiresAt] = useState('')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()
  const [plaintext, setPlaintext] = useState<string | null>(null)

  const close = () => {
    setName('')
    setScopes(['read', 'write'])
    setExpiresAt('')
    setIssues(undefined)
    setPlaintext(null)
    onClose()
  }

  const toggleScope = (scope: ApiKeyScope) =>
    setScopes(prev => (prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = createApiKeyRequestSchema.safeParse({
      name,
      scopes,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    create.mutate(parsed.data, { onSuccess: result => setPlaintext(result.key) })
  }

  const copy = async () => {
    if (!plaintext) return
    await navigator.clipboard.writeText(plaintext)
    showToast('API key copied to clipboard', 'success')
  }

  if (plaintext) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Your new API key"
        closeButton={false}
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={close}>
            Done
          </button>
        }
      >
        <div className="alert alert-warning text-sm mb-4" role="alert">
          <span>Copy it now — this is the only time it will be shown.</span>
        </div>
        <div className="join w-full">
          <input
            type="text"
            readOnly
            aria-label="API key"
            className="input join-item w-full font-mono text-xs"
            value={plaintext}
            onFocus={e => e.currentTarget.select()}
          />
          <button type="button" className="btn join-item gap-1" onClick={copy}>
            <ClipboardIcon className="w-4 h-4" />
            Copy
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create API key"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={close} disabled={create.isPending}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-key-form"
            className="btn btn-sm btn-primary"
            disabled={create.isPending}
          >
            {create.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Create'}
          </button>
        </>
      }
    >
      <form id="create-key-form" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="key-name" className="label text-sm">
            Name
          </label>
          <input
            id="key-name"
            className="input w-full"
            placeholder="e.g. CI pipeline"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'name')} />
        </div>
        <fieldset>
          <legend className="label text-sm">Scopes</legend>
          <div className="flex gap-4">
            {apiKeyScopeSchema.options.map(scope => (
              <label key={scope} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                {scope}
              </label>
            ))}
          </div>
          <FieldError message={fieldErrorFor(issues, 'scopes')} />
        </fieldset>
        <div>
          <label htmlFor="key-expires" className="label text-sm">
            Expires <span className="text-muted">(optional)</span>
          </label>
          <input
            id="key-expires"
            type="date"
            className="input w-full"
            value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'expiresAt')} />
        </div>
      </form>
    </Modal>
  )
}
