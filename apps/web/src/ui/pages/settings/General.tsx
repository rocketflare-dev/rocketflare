/**
 * Settings → General (D10, D25): organisation name (admin), slug (owner-only), tenant settings
 * (timezone, notifications), and the danger zone — delete the organisation, owner-only, hidden
 * entirely in single mode. Forms validate with the shared request schemas before submitting.
 */

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { updateTenantSettingsRequestSchema } from '@rocketflare/shared/tenant-settings'
import { updateTenantRequestSchema } from '@rocketflare/shared/tenants'
import { useEffect, useState } from 'react'
import {
  FieldError,
  fieldErrorFor,
  Modal,
  SectionPanel,
  SectionPanelSkeleton,
  SettingInput,
  SettingToggle,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import {
  useDeleteTenant,
  useTenant,
  useTenantSettings,
  useUpdateTenant,
  useUpdateTenantSettings,
} from '@/ui/hooks/useTenant'

type Issues = { path: PropertyKey[]; message: string }[] | undefined

export default function General() {
  return (
    <div className="space-y-4">
      <OrganisationPanel />
      <PreferencesPanel />
      <DangerZone />
    </div>
  )
}

function OrganisationPanel() {
  const { tenant: sessionTenant, tenancyMode, isGlobalAdmin } = useAuth()
  const { data: tenant, isLoading } = useTenant()
  const update = useUpdateTenant()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [issues, setIssues] = useState<Issues>()

  useEffect(() => {
    if (tenant) {
      setName(tenant.name)
      setSlug(tenant.slug)
    }
  }, [tenant])

  if (isLoading || !tenant) return <SectionPanelSkeleton rows={2} />

  // Explicit owner check (D10): `manage Tenant` is also held by support and global admins
  const canEditSlug = (sessionTenant?.role === 'owner' || isGlobalAdmin) && tenancyMode === 'multi'
  const dirty = name !== tenant.name || (canEditSlug && slug !== tenant.slug)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const body = {
      ...(name !== tenant.name ? { name } : {}),
      ...(canEditSlug && slug !== tenant.slug ? { slug } : {}),
    }
    const parsed = updateTenantRequestSchema.safeParse(body)
    if (!parsed.success) {
      setIssues(parsed.error.issues)
      return
    }
    setIssues(undefined)
    update.mutate(parsed.data)
  }

  return (
    <SectionPanel
      title={tenancyMode === 'single' ? 'Workspace' : 'Organisation'}
      description="What members see in the header and the switcher."
    >
      <form onSubmit={submit} noValidate>
        <SettingInput
          id="tenant-name"
          label="Name"
          value={name}
          onChange={setName}
          error={fieldErrorFor(issues, 'name')}
        />
        <SettingInput
          id="tenant-slug"
          label="URL slug"
          description={
            canEditSlug
              ? 'Lower-case letters, digits and hyphens. Changing it breaks old links.'
              : 'Only the owner can change the slug.'
          }
          value={slug}
          onChange={setSlug}
          disabled={!canEditSlug}
          error={fieldErrorFor(issues, 'slug')}
        />
        <FieldError message={issues?.find(i => i.path.length === 0)?.message} />
        <div className="flex justify-end pt-4">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!dirty || update.isPending}
          >
            {update.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Save'}
          </button>
        </div>
      </form>
    </SectionPanel>
  )
}

function PreferencesPanel() {
  const { data: settings, isLoading } = useTenantSettings()
  const update = useUpdateTenantSettings()
  const [timezone, setTimezone] = useState('')
  const [issues, setIssues] = useState<Issues>()

  useEffect(() => {
    if (settings) setTimezone(settings.timezone)
  }, [settings])

  if (isLoading || !settings) return <SectionPanelSkeleton rows={2} />

  const saveTimezone = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = updateTenantSettingsRequestSchema.safeParse({ timezone })
    if (!parsed.success) {
      setIssues(parsed.error.issues)
      return
    }
    setIssues(undefined)
    update.mutate(parsed.data)
  }

  return (
    <SectionPanel title="Preferences" description="Defaults for everyone in this organisation.">
      <form onSubmit={saveTimezone} noValidate>
        <SettingInput
          id="tenant-timezone"
          label="Timezone"
          description="IANA name, e.g. Europe/London."
          value={timezone}
          onChange={setTimezone}
          error={fieldErrorFor(issues, 'timezone')}
        />
        <div className="flex justify-end pt-4">
          <button
            type="submit"
            className="btn btn-sm"
            disabled={timezone === settings.timezone || update.isPending}
          >
            Save timezone
          </button>
        </div>
      </form>
      <SettingToggle
        id="tenant-notifications"
        label="In-app notifications"
        description="Turn off to silence every notification for this organisation."
        checked={settings.notificationsEnabled}
        disabled={update.isPending}
        onChange={notificationsEnabled => update.mutate({ notificationsEnabled })}
      />
    </SectionPanel>
  )
}

/** Owner ONLY (explicit role, D10) and multi mode ONLY (D25). */
function DangerZone() {
  const { tenant, tenancyMode } = useAuth()
  const remove = useDeleteTenant()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')

  if (tenant?.role !== 'owner' || tenancyMode === 'single') return null
  const matches = confirm.trim() === tenant.slug

  return (
    <SectionPanel
      title={<span className="text-error">Danger zone</span>}
      description="Deleting removes every member, invitation, key and record. There is no undo."
    >
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-secondary">Delete {tenant.name} permanently.</p>
        <button
          type="button"
          className="btn btn-error btn-sm btn-outline"
          onClick={() => setOpen(true)}
        >
          Delete organisation
        </button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this organisation?"
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOpen(false)}
              disabled={remove.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-error"
              disabled={!matches || remove.isPending}
              onClick={() => remove.mutate(confirm.trim())}
            >
              {remove.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Delete forever'
              )}
            </button>
          </>
        }
      >
        <div className="alert alert-warning text-sm mb-4" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" />
          <span>This cannot be undone. Every member loses access immediately.</span>
        </div>
        <label htmlFor="delete-confirm" className="label text-sm">
          Type <code className="font-mono">{tenant.slug}</code> to confirm
        </label>
        <input
          id="delete-confirm"
          className="input w-full font-mono"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="off"
        />
      </Modal>
    </SectionPanel>
  )
}
