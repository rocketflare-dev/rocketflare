/**
 * `/select-tenant` (D25, multi mode only): pick which organisation to work in, or create a new one
 * (`createTenantRequestSchema`; slug derived with the shared `slugify`). Disabled in single mode.
 */

import { BuildingOffice2Icon, ChevronRightIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  type CreateTenantRequest,
  createTenantRequestSchema,
  slugify,
} from '@rocketflare/shared/tenants'
import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard, SignedInAs } from '@/ui/components/AuthCard'
import { RoleBadge } from '@/ui/components/RoleBadge'
import { EmptyState, FieldError, fieldErrorFor } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useCreateTenant } from '@/ui/hooks/useTenant'

export default function SelectTenant() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, tenant, tenants, tenancyMode, selectTenant, logout } = useAuth()
  const [switching, setSwitching] = useState<string | null>(null)
  const [creating, setCreating] = useState(searchParams.get('create') === '1')

  if (tenancyMode === 'single') return <Navigate to="/" replace />

  const choose = async (id: string) => {
    if (id === tenant?.id) return navigate('/', { replace: true })
    setSwitching(id)
    try {
      await selectTenant(id)
      navigate('/', { replace: true })
    } finally {
      setSwitching(null)
    }
  }

  return (
    <AuthCard
      width="lg"
      footer={user ? <SignedInAs email={user.email} onSignOut={() => logout()} /> : null}
    >
      {creating ? (
        <CreateOrgForm onCancel={tenants.length > 0 ? () => setCreating(false) : undefined} />
      ) : (
        <>
          <h1 className="text-lg font-semibold mb-1">Choose an organisation</h1>
          <p className="text-sm text-secondary mb-5">Pick where to continue.</p>

          {tenants.length === 0 ? (
            <EmptyState
              icon={BuildingOffice2Icon}
              message="You don't belong to an organisation yet"
              description="Create one to get started."
            />
          ) : (
            <ul className="space-y-2">
              {tenants.map(t => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-3 surface-inset px-4 py-3 text-left hover:border-[color:var(--border-strong)] disabled:opacity-60"
                    onClick={() => choose(t.id)}
                    disabled={switching !== null}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{t.name}</div>
                      <div className="flex items-center gap-2 text-xs mt-0.5">
                        <RoleBadge role={t.role} />
                        <span className="text-muted font-mono">@{t.slug}</span>
                        {t.id === tenant?.id && (
                          <span className="badge badge-sm badge-ghost">current</span>
                        )}
                      </div>
                    </div>
                    {switching === t.id ? (
                      <span className="loading loading-spinner loading-sm" />
                    ) : (
                      <ChevronRightIcon className="w-5 h-5 text-muted" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="btn btn-outline btn-sm w-full mt-5 gap-2"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="w-4 h-4" />
            Create organisation
          </button>
        </>
      )}
    </AuthCard>
  )
}

function CreateOrgForm({ onCancel }: { onCancel?: () => void }) {
  const create = useCreateTenant()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  const effectiveSlug = slugTouched ? slug : name ? slugify(name) : ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const body: CreateTenantRequest = { name, ...(effectiveSlug ? { slug: effectiveSlug } : {}) }
    const parsed = createTenantRequestSchema.safeParse(body)
    if (!parsed.success) {
      setIssues(parsed.error.issues)
      return
    }
    setIssues(undefined)
    create.mutate(parsed.data)
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <h1 className="text-lg font-semibold mb-1">Create an organisation</h1>
        <p className="text-sm text-secondary">You'll be its owner and can invite others.</p>
      </div>
      <div>
        <label htmlFor="org-name" className="label text-sm">
          Name
        </label>
        <input
          id="org-name"
          className="input w-full"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Acme, Inc."
        />
        <FieldError message={fieldErrorFor(issues, 'name')} />
      </div>
      <div>
        <label htmlFor="org-slug" className="label text-sm">
          URL slug
        </label>
        <input
          id="org-slug"
          className="input w-full font-mono"
          value={effectiveSlug}
          onChange={e => {
            setSlugTouched(true)
            setSlug(e.target.value)
          }}
          placeholder="acme"
        />
        <FieldError message={fieldErrorFor(issues, 'slug')} />
      </div>
      <div className="flex gap-2 justify-end">
        {onCancel && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
            disabled={create.isPending}
          >
            Back
          </button>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={create.isPending}>
          {create.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Create'}
        </button>
      </div>
    </form>
  )
}
