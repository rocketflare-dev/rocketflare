/**
 * `/no-access` (D9, invite-only): signed in, in no organisation, and sign-up is by invitation.
 * Any pending invitations for this email are surfaced so the reader can accept one right here.
 */
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { Navigate } from 'react-router-dom'
import { AdminAreaLink, AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { PendingInvitationsBanner } from '@/ui/components/PendingInvitationsBanner'
import { useAuth } from '@/ui/hooks/useAuth'

export default function NoAccess() {
  const { user, tenant, tenants, logout, isGlobalAdmin } = useAuth()
  if (tenant) return <Navigate to="/" replace />
  if (tenants.length > 0) return <Navigate to="/select-tenant" replace />
  if (!user) return null

  return (
    <AuthCard footer={<SignedInAs email={user.email} onSignOut={() => logout()} />}>
      <div className="flex items-start gap-4">
        <span className="grid place-items-center w-11 h-11 shrink-0 rounded-full surface-inset">
          <LockClosedIcon className="w-5 h-5 text-muted" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold mb-1">You're not in an organisation yet</h1>
          <p className="text-sm text-secondary">
            Access is by invitation. Ask an administrator of your organisation to invite{' '}
            <span className="font-medium text-base-content">{user.email}</span>; the invitation will
            appear here and in your inbox.
          </p>
        </div>
      </div>
      <PendingInvitationsBanner className="mt-5" />
      {isGlobalAdmin && <AdminAreaLink className="mt-5" />}
    </AuthCard>
  )
}
