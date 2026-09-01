/**
 * `/pending` (D9, approval mode): the holding page for a signed-in person with no organisation.
 * Shows the access request's status; lets them lodge one (or add a note) via
 * `POST /api/access-requests` with the shared `createAccessRequestSchema`.
 */

import { createAccessRequestSchema } from '@gmgo/shared/access-requests'
import { ClockIcon, NoSymbolIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { FieldError, fieldErrorFor } from '@/ui/components/shared'
import { useCreateAccessRequest } from '@/ui/hooks/useAccessRequests'
import { useAuth } from '@/ui/hooks/useAuth'

export default function Pending() {
  const { user, tenant, tenants, session, logout } = useAuth()
  const request = useCreateAccessRequest()
  const [message, setMessage] = useState('')
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [showNote, setShowNote] = useState(false)

  if (tenant) return <Navigate to="/" replace />
  if (tenants.length > 0) return <Navigate to="/select-tenant" replace />
  if (!user || !session) return null

  const accessRequest = session.accessRequest
  const rejected = accessRequest?.status === 'rejected'
  const pending = accessRequest?.status === 'pending'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = createAccessRequestSchema.safeParse({
      email: user.email,
      ...(message.trim() ? { message: message.trim() } : {}),
    })
    if (!parsed.success) {
      setFieldError(fieldErrorFor(parsed.error.issues, 'message') ?? 'Check your message')
      return
    }
    setFieldError(undefined)
    request.mutate(parsed.data, {
      onSuccess: () => {
        setMessage('')
        setShowNote(false)
      },
    })
  }

  return (
    <AuthCard footer={<SignedInAs email={user.email} onSignOut={() => logout()} />}>
      <div className="flex items-start gap-4">
        <span className="grid place-items-center w-11 h-11 shrink-0 rounded-full surface-inset">
          {rejected ? (
            <NoSymbolIcon className="w-5 h-5 text-muted" />
          ) : (
            <ClockIcon className="w-5 h-5 text-muted" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {rejected ? (
            <>
              <h1 className="text-lg font-semibold mb-1">Access wasn't granted</h1>
              <p className="text-sm text-secondary">
                Your request to join wasn't approved. If you think that's a mistake, contact an
                administrator.
              </p>
            </>
          ) : pending ? (
            <>
              <h1 className="text-lg font-semibold mb-1">Your request is with us</h1>
              <p className="text-sm text-secondary">
                You're signed in, but not part of an organisation yet. An administrator will review
                your request — you'll get an email as soon as you're in.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold mb-1">Request access</h1>
              <p className="text-sm text-secondary">
                This app is approval-only. Tell an administrator who you are and they'll add you to
                the right organisation.
              </p>
            </>
          )}
        </div>
      </div>

      {!rejected && (showNote || !accessRequest) && (
        <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
          <div>
            <label htmlFor="access-message" className="label text-sm">
              Message <span className="text-muted">(optional)</span>
            </label>
            <textarea
              id="access-message"
              className="textarea w-full"
              rows={3}
              maxLength={1000}
              placeholder="Which team are you on? Who can vouch for you?"
              value={message}
              onChange={e => setMessage(e.target.value)}
            />
            <FieldError message={fieldError} />
          </div>
          <div className="flex justify-end gap-2">
            {accessRequest && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowNote(false)}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={request.isPending}
            >
              {request.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <PaperAirplaneIcon className="w-4 h-4" />
              )}
              {accessRequest ? 'Add note' : 'Send request'}
            </button>
          </div>
        </form>
      )}

      {pending && !showNote && (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-5"
          onClick={() => setShowNote(true)}
        >
          Add a note to your request
        </button>
      )}
    </AuthCard>
  )
}
