/**
 * Your account (D13): name/avatar (`updateProfileRequestSchema` → `PATCH /api/me`) and the
 * sign-in methods linked to it. Connecting a provider is a full-page OAuth round trip with
 * `?returnUrl=/profile`; disconnecting is refused when it would leave no way to sign in.
 */

import { updateProfileRequestSchema } from '@gmgo/shared/user-settings'
import { LinkIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import { PROVIDER_ICONS, PROVIDER_LABELS } from '@/ui/components/icons/ProviderIcons'
import {
  FieldError,
  fieldErrorFor,
  PageHeader,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useAuthMethods } from '@/ui/hooks/useAuthMethods'
import {
  useLinkedProviders,
  useMe,
  useUnlinkProvider,
  useUpdateProfile,
} from '@/ui/hooks/useProfile'
import { formatDate, initials } from '@/ui/lib/format'
import { hardNavigate } from '@/ui/lib/navigation'

export default function Profile() {
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader
        title="Your account"
        description="How you appear to others, and how you sign in."
      />
      <ProfileForm />
      <SignInMethods />
    </div>
  )
}

function ProfileForm() {
  const { user: sessionUser } = useAuth()
  const { data } = useMe()
  const user = data ?? sessionUser
  const update = useUpdateProfile()
  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  useEffect(() => {
    if (user) {
      setName(user.name)
      setAvatarUrl(user.avatarUrl ?? '')
    }
  }, [user])

  if (!user)
    return (
      <SectionPanel title="Profile">
        <SkeletonRows rows={3} />
      </SectionPanel>
    )

  const dirty = name !== user.name || (avatarUrl || null) !== (user.avatarUrl ?? null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = updateProfileRequestSchema.safeParse({
      name,
      avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
    })
    if (!parsed.success) {
      setIssues(parsed.error.issues)
      return
    }
    setIssues(undefined)
    update.mutate(parsed.data)
  }

  return (
    <SectionPanel title="Profile">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex items-center gap-4">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-14 h-14 rounded-full" />
          ) : (
            <span className="w-14 h-14 rounded-full grid place-items-center text-lg font-semibold tone-primary">
              {initials(user.name, user.email)}
            </span>
          )}
          <div className="text-sm">
            <div className="font-medium">{user.email}</div>
            <div className="text-muted">
              Member since {formatDate(user.createdAt)}
              {user.emailVerifiedAt ? ' · email verified' : ''}
              {user.isGlobalAdmin ? ' · global admin' : ''}
            </div>
          </div>
        </div>
        <div>
          <label htmlFor="profile-name" className="label text-sm">
            Name
          </label>
          <input
            id="profile-name"
            className="input w-full max-w-md"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'name')} />
        </div>
        <div>
          <label htmlFor="profile-avatar" className="label text-sm">
            Avatar URL <span className="text-muted">(optional)</span>
          </label>
          <input
            id="profile-avatar"
            type="url"
            className="input w-full max-w-md"
            placeholder="https://…"
            value={avatarUrl}
            onChange={e => setAvatarUrl(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'avatarUrl')} />
        </div>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!dirty || update.isPending}
        >
          {update.isPending ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            'Save changes'
          )}
        </button>
      </form>
    </SectionPanel>
  )
}

function SignInMethods() {
  const { data: methods } = useAuthMethods()
  const { data: linked, isLoading } = useLinkedProviders()
  const unlink = useUnlinkProvider()
  const linkedSet = new Set((linked?.providers ?? []).map(p => p.provider))
  const providers = methods?.providers ?? []
  const canDisconnect = (methods?.magicLink ?? false) || linkedSet.size > 1

  return (
    <SectionPanel
      title="Sign-in methods"
      description="Connect more than one so you're never locked out."
    >
      {isLoading ? (
        <SkeletonRows rows={2} />
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {methods?.magicLink && (
            <li className="flex items-center gap-3 py-3">
              <LinkIcon className="w-5 h-5 text-muted" />
              <span className="flex-1 text-sm font-medium">Email sign-in link</span>
              <span className="badge badge-sm badge-success">Always available</span>
            </li>
          )}
          {providers.map(provider => {
            const Icon = PROVIDER_ICONS[provider]
            const isLinked = linkedSet.has(provider)
            return (
              <li key={provider} className="flex items-center gap-3 py-3">
                <Icon className="w-5 h-5" />
                <span className="flex-1 text-sm font-medium">{PROVIDER_LABELS[provider]}</span>
                {isLinked ? (
                  <>
                    <span className="badge badge-sm badge-success">Connected</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      disabled={!canDisconnect || unlink.isPending}
                      title={canDisconnect ? undefined : 'Your only way to sign in'}
                      onClick={() => unlink.mutate(provider)}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() =>
                      hardNavigate(`/auth/${provider}?returnUrl=${encodeURIComponent('/profile')}`)
                    }
                  >
                    Connect
                  </button>
                )}
              </li>
            )
          })}
          {providers.length === 0 && !methods?.magicLink && (
            <li className="py-3 text-sm text-muted">No sign-in providers are configured.</li>
          )}
        </ul>
      )}
    </SectionPanel>
  )
}
