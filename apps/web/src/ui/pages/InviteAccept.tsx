/**
 * `/invite/:token` (D9): look the invitation up, get the reader signed in as the invited address,
 * accept, and land inside the org with the session the server returned. A reader signed in under a
 * different email is told so and offered a switch (sign out → login with this page as returnUrl).
 */
import { CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { RoleBadge } from '@/ui/components/RoleBadge'
import { useAuth } from '@/ui/hooks/useAuth'
import { invitationDetailsQueryOptions, useAcceptInvitation } from '@/ui/hooks/useInvitations'
import { ApiError } from '@/ui/lib/api-client'
import { formatDate } from '@/ui/lib/format'
import { loginUrl } from '@/ui/lib/navigation'

export default function InviteAccept() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { status, user, applySession, logout } = useAuth()
  const details = useQuery(invitationDetailsQueryOptions(token))
  const accept = useAcceptInvitation()
  const [acceptError, setAcceptError] = useState<string | null>(null)

  const invitePath = `/invite/${encodeURIComponent(token)}`

  if (!token) {
    return (
      <AuthCard>
        <Problem title="Invalid invitation" message="This link is missing its invitation token." />
      </AuthCard>
    )
  }

  if (details.isLoading || status === 'loading') {
    return (
      <AuthCard>
        <LoadingIndicator fullPage />
      </AuthCard>
    )
  }

  if (details.isError || !details.data) {
    const error = details.error
    const message =
      error instanceof ApiError && error.status === 404
        ? 'This invitation does not exist or has been withdrawn.'
        : (error?.message ?? 'Could not load this invitation.')
    return (
      <AuthCard>
        <Problem title="Invitation not found" message={message} />
      </AuthCard>
    )
  }

  const invitation = details.data
  const expired = invitation.status === 'expired' || invitation.expiresAt < new Date()

  if (invitation.status === 'accepted') {
    return (
      <AuthCard>
        <div className="text-center">
          <CheckCircleIcon className="w-10 h-10 mx-auto mb-3 text-success" />
          <h1 className="text-lg font-semibold mb-1">Already accepted</h1>
          <p className="text-sm text-secondary mb-5">
            This invitation to <strong>{invitation.tenant.name}</strong> has already been used.
          </p>
          <Link to="/" className="btn btn-primary btn-sm">
            Go to the app
          </Link>
        </div>
      </AuthCard>
    )
  }

  if (invitation.status === 'revoked') {
    return (
      <AuthCard>
        <Problem
          title="Invitation withdrawn"
          message={`This invitation to ${invitation.tenant.name} was revoked. Ask whoever invited you for a new one.`}
        />
      </AuthCard>
    )
  }

  if (expired) {
    return (
      <AuthCard>
        <div className="text-center">
          <ClockIcon className="w-10 h-10 mx-auto mb-3 text-warning" />
          <h1 className="text-lg font-semibold mb-1">Invitation expired</h1>
          <p className="text-sm text-secondary">
            This invitation to <strong>{invitation.tenant.name}</strong> expired on{' '}
            {formatDate(invitation.expiresAt)}. Ask whoever invited you to send another.
          </p>
        </div>
      </AuthCard>
    )
  }

  // Not signed in: the server needs a session to bind the acceptance to
  if (status === 'unauthenticated') return <Navigate to={loginUrl(invitePath)} replace />

  const mismatch = user !== null && user.email.toLowerCase() !== invitation.email.toLowerCase()

  const onAccept = async () => {
    setAcceptError(null)
    try {
      const session = await accept.mutateAsync(token)
      applySession(session)
      navigate('/', { replace: true })
    } catch (error) {
      setAcceptError(error instanceof Error ? error.message : 'Could not accept the invitation')
    }
  }

  return (
    <AuthCard
      footer={user ? <SignedInAs email={user.email} onSignOut={() => logout(invitePath)} /> : null}
    >
      <h1 className="text-lg font-semibold mb-4">You've been invited</h1>

      <div className="surface-inset px-4 py-4 mb-5">
        <div className="text-xs text-secondary uppercase tracking-wide">Organisation</div>
        <div className="text-lg font-semibold">{invitation.tenant.name}</div>
        <div className="text-sm text-secondary mt-2 flex items-center gap-2">
          Joining as <RoleBadge role={invitation.role} />
        </div>
        <dl className="mt-3 text-xs text-muted grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>For</dt>
          <dd className="font-medium text-secondary">{invitation.email}</dd>
          {invitation.invitedByName && (
            <>
              <dt>From</dt>
              <dd>{invitation.invitedByName}</dd>
            </>
          )}
          <dt>Expires</dt>
          <dd>{formatDate(invitation.expiresAt)}</dd>
        </dl>
      </div>

      {mismatch ? (
        <div className="alert alert-warning text-sm mb-4" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
          <div>
            <div className="font-semibold">Different account</div>
            <div>
              This invitation is for <strong>{invitation.email}</strong>, but you're signed in as{' '}
              <strong>{user?.email}</strong>. Sign out and sign in with the invited address to
              accept it.
            </div>
          </div>
        </div>
      ) : (
        acceptError && (
          <div className="alert alert-error text-sm mb-4" role="alert">
            <span>{acceptError}</span>
          </div>
        )
      )}

      <div className="flex flex-col gap-2">
        {mismatch ? (
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => logout(invitePath)}
          >
            Sign out and switch account
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={accept.isPending}
            onClick={onAccept}
          >
            {accept.isPending ? <LoadingIndicator size="sm" /> : 'Accept invitation'}
          </button>
        )}
        <Link to="/" className="btn btn-ghost btn-sm">
          Not now
        </Link>
      </div>
    </AuthCard>
  )
}

function Problem({ title, message }: { title: string; message: string }) {
  return (
    <div className="text-center">
      <ExclamationTriangleIcon className="w-10 h-10 mx-auto mb-3 text-error" />
      <h1 className="text-lg font-semibold mb-1">{title}</h1>
      <p className="text-sm text-secondary mb-5">{message}</p>
      <Link to="/" className="btn btn-primary btn-sm">
        Go to the app
      </Link>
    </div>
  )
}
