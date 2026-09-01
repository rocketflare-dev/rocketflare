/**
 * Invitations waiting for the signed-in email, across tenants (D9) — so a member of one org can
 * join another without hunting for the email. Renders nothing when there are none. Links to
 * `/invite/<token>` when the server includes the token (see `pendingInvitationSchema`).
 */
import { EnvelopeIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { usePendingInvitations } from '@/ui/hooks/useInvitations'

export function PendingInvitationsBanner({ className = '' }: { className?: string }) {
  const { data } = usePendingInvitations()
  const items = (data?.items ?? []).filter(i => i.status === 'pending')
  if (items.length === 0) return null

  return (
    <section
      className={`surface-panel !p-0 overflow-hidden border-l-2 border-l-[color:var(--color-info)] ${className}`}
      aria-label="Pending invitations"
    >
      <ul className="divide-y divide-[color:var(--border-subtle)]">
        {items.map(invite => {
          const orgName = invite.tenant?.name ?? invite.tenantName ?? 'an organisation'
          return (
            <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
              <EnvelopeIcon className="w-5 h-5 shrink-0 text-info" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">You've been invited to join {orgName}</div>
                <div className="text-xs text-secondary capitalize">as {invite.role}</div>
              </div>
              {invite.token ? (
                <Link
                  to={`/invite/${encodeURIComponent(invite.token)}`}
                  className="btn btn-primary btn-sm"
                >
                  Accept
                </Link>
              ) : (
                <span className="text-xs text-muted">Use the link in your email</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default PendingInvitationsBanner
