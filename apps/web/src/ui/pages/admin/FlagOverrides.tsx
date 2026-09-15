/**
 * Per-organisation overrides for one flag (D30). Multi-tenant only — the parent hides this in
 * single mode, matching the routes, which answer 404 `tenancy_mode_single`.
 *
 * Three states, never a checkbox: On and Off are both real decisions (the design-partner
 * allow-list and the "this customer must never get it" block-list), while Default — deleting the
 * row — means "follow the platform state". A checkbox cannot say the third thing.
 */
import { TrashIcon } from '@heroicons/react/24/outline'
import type { FeatureFlag } from '@rocketflare/shared/features'
import { useState } from 'react'
import { showToast } from '@/ui/components/shared'
import { useAdminTenants } from '@/ui/hooks/useAdminTenants'
import {
  useClearTenantOverride,
  useFlagOverrides,
  useSetTenantOverride,
} from '@/ui/hooks/useFeatureFlags'

export function FlagOverrides({ flag }: { flag: FeatureFlag }) {
  const [open, setOpen] = useState(false)
  const { data } = useFlagOverrides(flag.key, open)
  const { data: tenants } = useAdminTenants({ pageSize: 100 }, { enabled: open })
  const set = useSetTenantOverride(flag.key)
  const clear = useClearTenantOverride(flag.key)
  const [tenantId, setTenantId] = useState('')

  const overrides = data?.items ?? []
  const overridden = new Set(overrides.map(o => o.tenantId))
  const candidates = (tenants?.items ?? []).filter(t => !overridden.has(t.id))

  const onError = (err: unknown) => showToast((err as Error).message, 'error')

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-muted">
        Per-organisation overrides{flag.overrideCount > 0 ? ` (${flag.overrideCount})` : ''}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted">
          An override wins over the rollout in both directions. Remove it to follow the platform
          state again.
        </p>
        {overrides.length > 0 && (
          <table className="data-table text-sm">
            <tbody>
              {overrides.map(o => (
                <tr key={o.tenantId}>
                  <td>{o.tenantName}</td>
                  <td>
                    <span className={`status-badge ${o.enabled ? 'badge-success' : 'badge-ghost'}`}>
                      {o.enabled ? 'Forced on' : 'Forced off'}
                    </span>
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      aria-label={`Remove the override for ${o.tenantName}`}
                      onClick={() => clear.mutate(o.tenantId, { onError })}
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="select select-sm select-bordered"
            value={tenantId}
            aria-label="Organisation"
            onChange={e => setTenantId(e.target.value)}
          >
            <option value="">Choose an organisation…</option>
            {candidates.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!tenantId || set.isPending}
            onClick={() =>
              set.mutate({ tenantId, enabled: true }, { onError, onSuccess: () => setTenantId('') })
            }
          >
            Force on
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!tenantId || set.isPending}
            onClick={() =>
              set.mutate(
                { tenantId, enabled: false },
                { onError, onSuccess: () => setTenantId('') }
              )
            }
          >
            Force off
          </button>
        </div>
      </div>
    </details>
  )
}
