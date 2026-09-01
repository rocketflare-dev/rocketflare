/**
 * Admin → Organisations (D25): search + status filter over `/api/admin/tenants`. In single mode
 * there is exactly one, so the list collapses straight into its detail.
 */

import type { TenantStatus } from '@gmgo/shared/tenants'
import { BuildingOffice2Icon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  EmptyState,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAdminTenants } from '@/ui/hooks/useAdminTenants'
import { useAuth } from '@/ui/hooks/useAuth'
import { timeAgo } from '@/ui/lib/format'

const FILTERS: { value: TenantStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
]

export default function TenantList() {
  const { tenancyMode } = useAuth()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<TenantStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useAdminTenants({
    q,
    page,
    status: status === 'all' ? undefined : status,
  })
  const items = data?.items ?? []

  if (tenancyMode === 'single' && data && items.length === 1 && !q && status === 'all') {
    return <Navigate to={`/admin/tenants/${items[0].id}`} replace />
  }

  return (
    <SectionPanel
      flush
      title="Organisations"
      description={data ? `${data.pagination.total} total` : undefined}
      actions={
        <>
          <div role="tablist" className="tabs tabs-box tabs-sm">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                role="tab"
                className={`tab ${status === f.value ? 'tab-active' : ''}`}
                onClick={() => {
                  setStatus(f.value)
                  setPage(1)
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <SearchInput
            value={q}
            onChange={v => {
              setQ(v)
              setPage(1)
            }}
            size="sm"
            placeholder="Search name or slug"
          />
        </>
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={BuildingOffice2Icon} message="No organisations match" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Members</th>
                <th>Last active</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td>
                    <div className="font-medium flex items-center gap-2">
                      {t.name}
                      {t.status === 'suspended' && (
                        <span className="badge badge-sm badge-error">suspended</span>
                      )}
                    </div>
                    <div className="text-xs text-muted font-mono">@{t.slug}</div>
                  </td>
                  <td className="tabular-nums">{t.memberCount}</td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(t.lastAccessedAt)}</td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(t.createdAt)}</td>
                  <td className="text-right">
                    <Link to={`/admin/tenants/${t.id}`} className="btn btn-ghost btn-xs gap-1">
                      Open <ChevronRightIcon className="w-3.5 h-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={data.pagination}
            onPageChange={setPage}
            isLoading={isFetching}
          />
        </div>
      )}
    </SectionPanel>
  )
}
