/**
 * Header organisation switcher (D25). Hidden entirely in `single` mode; in `multi` mode it lists
 * every membership and offers "Create organisation". `<details>/<summary>` dropdown per ui.md.
 */
import {
  BuildingOffice2Icon,
  CheckIcon,
  ChevronUpDownIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/ui/hooks/useAuth'
import { showToast } from '@/ui/lib/api-client'
import { RoleBadge } from './RoleBadge'

export function OrgSwitcher() {
  const { tenant, tenants, tenancyMode, selectTenant } = useAuth()
  const navigate = useNavigate()
  const ref = useRef<HTMLDetailsElement>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  const canCreate = tenancyMode === 'multi'
  if (tenancyMode === 'single') return null
  // A global admin on /admin with no membership: say so instead of rendering a switcher with nothing
  // to switch (the header slot would otherwise be blank).
  if (!tenant) {
    return (
      <span className="text-sm text-muted inline-flex items-center gap-1.5 px-2">
        <BuildingOffice2Icon className="w-4 h-4 shrink-0" />
        No organisation
      </span>
    )
  }
  if (tenants.length < 2 && !canCreate) return null

  const close = () => ref.current?.removeAttribute('open')

  const switchTo = async (id: string) => {
    if (id === tenant.id) return close()
    setSwitching(id)
    try {
      await selectTenant(id)
      close()
      navigate('/', { replace: true })
    } catch {
      showToast('Could not switch organisation', 'error')
    } finally {
      setSwitching(null)
    }
  }

  return (
    <details ref={ref} className="dropdown">
      <summary
        className="btn btn-ghost btn-sm gap-1.5 max-w-[14rem] font-medium list-none"
        aria-label={`Organisation: ${tenant.name}`}
      >
        <BuildingOffice2Icon className="w-4 h-4 text-muted shrink-0" />
        <span className="truncate">{tenant.name}</span>
        <ChevronUpDownIcon className="w-4 h-4 text-muted shrink-0" />
      </summary>
      <ul className="dropdown-content popover-surface z-50 mt-1 w-72 p-1.5 space-y-0.5">
        <li className="nav-group-label px-2.5 pt-1 pb-1.5">Your organisations</li>
        {tenants.map(t => (
          <li key={t.id}>
            <button
              type="button"
              className="nav-item flex w-full items-center gap-2 px-2.5 py-1.5 text-sm"
              onClick={() => switchTo(t.id)}
              disabled={switching !== null}
              aria-current={t.id === tenant.id ? 'true' : undefined}
            >
              <span className="flex-1 min-w-0 text-left">
                <span className="block truncate">{t.name}</span>
                <span className="block text-xs text-muted font-mono">@{t.slug}</span>
              </span>
              <RoleBadge role={t.role} />
              {switching === t.id ? (
                <span className="loading loading-spinner loading-xs" />
              ) : t.id === tenant.id ? (
                <CheckIcon className="w-4 h-4 text-primary" />
              ) : null}
            </button>
          </li>
        ))}
        {canCreate && (
          <>
            <li className="border-t border-[color:var(--border-subtle)] my-1" />
            <li>
              <Link
                to="/select-tenant?create=1"
                onClick={close}
                className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
              >
                <PlusIcon className="w-4 h-4" />
                Create organisation
              </Link>
            </li>
          </>
        )}
      </ul>
    </details>
  )
}

export default OrgSwitcher
