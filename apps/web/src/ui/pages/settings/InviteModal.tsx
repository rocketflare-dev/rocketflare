/**
 * Invite people (D9): one address (`inviteMemberRequestSchema`) or a pasted list
 * (`bulkInviteRequestSchema`, ≤ BULK_INVITE_MAX). The owner role is offered only to owners.
 */
import {
  BULK_INVITE_MAX,
  bulkInviteRequestSchema,
  inviteMemberRequestSchema,
  type TenantRole,
  tenantRoleSchema,
} from '@rocketflare/shared/tenants'
import { useState } from 'react'
import { FieldError, fieldErrorFor, Modal } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useBulkInvite, useInviteMember } from '@/ui/hooks/useInvitations'

/** Split a pasted list on commas, semicolons, whitespace and newlines; drop blanks and dupes. */
export function parseEmailList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]
}

export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant, isGlobalAdmin } = useAuth()
  const invite = useInviteMember()
  const bulk = useBulkInvite()
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [email, setEmail] = useState('')
  const [emails, setEmails] = useState('')
  const [role, setRole] = useState<TenantRole>('member')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  const canAssignOwner = tenant?.role === 'owner' || isGlobalAdmin
  const roles = tenantRoleSchema.options.filter(r => r !== 'owner' || canAssignOwner)
  const pending = invite.isPending || bulk.isPending

  const reset = () => {
    setEmail('')
    setEmails('')
    setRole('member')
    setIssues(undefined)
  }
  const close = () => {
    reset()
    onClose()
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'single') {
      const parsed = inviteMemberRequestSchema.safeParse({ email, role })
      if (!parsed.success) return setIssues(parsed.error.issues)
      setIssues(undefined)
      invite.mutate(parsed.data, { onSuccess: close })
    } else {
      const parsed = bulkInviteRequestSchema.safeParse({ emails: parseEmailList(emails), role })
      if (!parsed.success) return setIssues(parsed.error.issues)
      setIssues(undefined)
      bulk.mutate(parsed.data, { onSuccess: close })
    }
  }

  const emailsIssue = issues?.find(i => i.path[0] === 'emails')
  const count = parseEmailList(emails).length

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite people"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button
            type="submit"
            form="invite-form"
            className="btn btn-sm btn-primary"
            disabled={pending}
          >
            {pending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : mode === 'single' ? (
              'Send invitation'
            ) : (
              `Send ${count || ''} invitations`
            )}
          </button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="space-y-4" noValidate>
        <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
          <button
            type="button"
            role="tab"
            className={`tab ${mode === 'single' ? 'tab-active' : ''}`}
            onClick={() => setMode('single')}
          >
            One person
          </button>
          <button
            type="button"
            role="tab"
            className={`tab ${mode === 'bulk' ? 'tab-active' : ''}`}
            onClick={() => setMode('bulk')}
          >
            Several
          </button>
        </div>

        {mode === 'single' ? (
          <div>
            <label htmlFor="invite-email" className="label text-sm">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              className="input w-full"
              placeholder="colleague@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <FieldError message={fieldErrorFor(issues, 'email')} />
          </div>
        ) : (
          <div>
            <label htmlFor="invite-emails" className="label text-sm">
              Email addresses{' '}
              <span className="text-muted">
                (one per line, or comma-separated; up to {BULK_INVITE_MAX})
              </span>
            </label>
            <textarea
              id="invite-emails"
              className="textarea w-full font-mono text-xs"
              rows={6}
              value={emails}
              onChange={e => setEmails(e.target.value)}
            />
            <FieldError
              message={
                emailsIssue
                  ? emailsIssue.path.length > 1
                    ? `Address #${Number(emailsIssue.path[1]) + 1} is not a valid email`
                    : emailsIssue.message
                  : undefined
              }
            />
            {count > 0 && (
              <p className="text-xs text-muted mt-1">
                {count} address{count === 1 ? '' : 'es'}
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="invite-role" className="label text-sm">
            Role
          </label>
          <select
            id="invite-role"
            className="select w-full capitalize"
            value={role}
            onChange={e => setRole(e.target.value as TenantRole)}
          >
            {roles.map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrorFor(issues, 'role')} />
        </div>
      </form>
    </Modal>
  )
}
