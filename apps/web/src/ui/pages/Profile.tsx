/**
 * Your account (D13): name/avatar (`updateProfileRequestSchema` → `PATCH /api/me`), an avatar
 * upload (`POST /api/files?scope=avatars`, D23 — type/size checked client-side first) and the
 * sign-in methods linked to it. Connecting a provider is a full-page OAuth round trip with
 * `?returnUrl=/profile`; disconnecting is refused when it would leave no way to sign in.
 */

import { updateProfileRequestSchema } from '@gmgo/shared/user-settings'
import { LinkIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
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
  AVATAR_ACCEPT,
  useLinkedProviders,
  useMe,
  useUnlinkProvider,
  useUpdateProfile,
  useUploadAvatar,
  validateAvatarFile,
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
          {/* keyed on the URL so a failed load resets when a new photo arrives */}
          <Avatar
            key={user.avatarUrl ?? ''}
            name={user.name}
            email={user.email}
            avatarUrl={user.avatarUrl}
          />
          <div className="text-sm">
            <div className="font-medium">{user.email}</div>
            <div className="text-muted">
              Member since {formatDate(user.createdAt)}
              {user.emailVerifiedAt ? ' · email verified' : ''}
              {user.isGlobalAdmin ? ' · global admin' : ''}
            </div>
          </div>
        </div>
        <AvatarUpload hasAvatar={Boolean(user.avatarUrl)} />
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

/** The picture, or initials when there is none or it fails to load (e.g. uploaded in another org). */
function Avatar({
  name,
  email,
  avatarUrl,
}: {
  name: string
  email: string
  avatarUrl: string | null
}) {
  const [broken, setBroken] = useState(false)
  if (avatarUrl && !broken) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="w-14 h-14 rounded-full object-cover"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span className="w-14 h-14 rounded-full grid place-items-center text-lg font-semibold tone-primary">
      {initials(name, email)}
    </span>
  )
}

/**
 * Upload a photo (D23). The file is checked against the shared allowlist/limit before any
 * request; the server's 415/413 remain the backstop. "Remove" clears `avatarUrl` via PATCH — the
 * stored object stays until its file is deleted (see CONCEPTS: storage).
 */
function AvatarUpload({ hasAvatar }: { hasAvatar: boolean }) {
  const upload = useUploadAvatar()
  const update = useUpdateProfile()
  const inputRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const busy = upload.isPending || update.isPending

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const message = validateAvatarFile(file)
    setProblem(message)
    if (!message) upload.mutate(file)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id="profile-avatar-file"
          type="file"
          accept={AVATAR_ACCEPT}
          className="hidden"
          aria-label="Upload photo"
          onChange={onChange}
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn-outline btn-xs"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            'Upload photo'
          )}
        </button>
        {hasAvatar && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => update.mutate({ avatarUrl: null })}
          >
            Remove
          </button>
        )}
        <span className="text-xs text-muted">PNG, JPEG, GIF or WebP, up to 5 MB.</span>
      </div>
      <FieldError message={problem ?? undefined} />
    </div>
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
