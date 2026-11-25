/**
 * Home's team area (core): the faces, how many people hold each role, and the invitations still
 * waiting. With nobody else here yet, the area IS the onboarding: an invite field, through the
 * same invitation mutation People uses. Admins get a way into People; everyone else sees who is
 * here.
 */
import { UserPlusIcon } from '@heroicons/react/24/outline'
import type { HomeTeam as Team } from '@rocketflare/shared/home'
import { inviteMemberRequestSchema, roleLabel, type TenantRole } from '@rocketflare/shared/tenants'
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { AvatarStack, FieldError, SectionPanel, SectionPanelSkeleton } from '@/ui/components/shared'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { useInviteMember } from '@/ui/hooks/useInvitations'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { timeAgo } from '@/ui/lib/format'
import { queryKeys } from '@/ui/lib/query-keys'
import { settingsTabPath } from '../settings/tabs'

const ROLE_ORDER: TenantRole[] = ['owner', 'admin', 'member']

/** "1 owner · 2 admins · 9 members" — only the roles somebody holds. */
export function roleCounts(roles: Team['roles']): string {
  return ROLE_ORDER.filter(r => roles[r] > 0)
    .map(r => {
      const word = roleLabel(r).toLowerCase()
      return `${roles[r]} ${roles[r] === 1 ? word : `${word}s`}`
    })
    .join(' · ')
}

export function HomeTeam() {
  const { data, isLoading } = useHomeSummary()
  const { can } = usePermissions()
  if (isLoading) return <SectionPanelSkeleton rows={2} />
  const team = data?.team
  if (!team) return null
  const canManage = can('manage', 'TenantMember')
  const canInvite = can('create', 'Invitation')
  const invitations = team.invitations
  const alone = team.total <= 1 && (invitations?.total ?? 0) === 0

  return (
    <SectionPanel
      title="Team"
      description={`${team.total === 1 ? '1 person' : `${team.total} people`} · ${roleCounts(team.roles)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AvatarStack
          people={team.members.map(m => ({ id: m.userId, name: m.name, avatarUrl: m.avatarUrl }))}
          total={team.total}
        />
        {canManage && (
          <Link to={settingsTabPath('people')} className="link text-sm">
            Manage people
          </Link>
        )}
      </div>

      {invitations && invitations.total > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">
            {invitations.total === 1
              ? '1 invitation waiting'
              : `${invitations.total} invitations waiting`}
          </p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {invitations.recent.map(inv => (
              <li key={inv.id} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-secondary">{inv.email}</span>
                <span className="text-xs text-muted whitespace-nowrap">
                  sent {timeAgo(inv.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {alone && canInvite && (
        <div className="mt-4">
          <p className="text-sm text-secondary mb-2">
            It is just you so far. Invite the people you work with.
          </p>
          <InviteField />
        </div>
      )}
    </SectionPanel>
  )
}

/** One email, one button — People has the rest (roles, many at once). */
export function InviteField() {
  const invite = useInviteMember()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | undefined>()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = inviteMemberRequestSchema.safeParse({ email })
    if (!parsed.success) return setError('Enter an email address')
    setError(undefined)
    invite.mutate(parsed.data, {
      onSuccess: () => {
        setEmail('')
        void queryClient.invalidateQueries({ queryKey: queryKeys.home.all })
      },
    })
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="home-invite-email">
          Email address to invite
        </label>
        <input
          id="home-invite-email"
          type="email"
          className="input input-sm flex-1 min-w-0"
          placeholder="name@company.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'home-invite-error' : undefined}
          disabled={invite.isPending}
        />
        <button
          type="submit"
          className="btn btn-sm btn-primary gap-1.5"
          disabled={invite.isPending}
        >
          <UserPlusIcon className="w-4 h-4" />
          Invite
        </button>
      </div>
      <FieldError id="home-invite-error" message={error} />
    </form>
  )
}
