/** Admin → Users (D10): search + filter over `/api/admin/users` (`adminUserListQuerySchema`). */

import { ChevronRightIcon, UsersIcon } from '@heroicons/react/24/outline'
import type { AdminUserListQuery } from '@rocketflare/shared/admin'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  EmptyState,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAdminUsers } from '@/ui/hooks/useAdminUsers'
import { timeAgo } from '@/ui/lib/format'

type Filter = NonNullable<AdminUserListQuery['filter']> | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'no_tenant', label: 'No organisation' },
  { value: 'global_admin', label: 'Global admins' },
  { value: 'blocked', label: 'Blocked' },
]

export default function UserList() {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useAdminUsers({
    q,
    page,
    filter: filter === 'all' ? undefined : filter,
  })
  const items = data?.items ?? []

  return (
    <SectionPanel
      flush
      title="Users"
      description={data ? `${data.pagination.total} total` : undefined}
      actions={
        <>
          <div role="tablist" className="tabs tabs-box tabs-sm">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                role="tab"
                className={`tab ${filter === f.value ? 'tab-active' : ''}`}
                onClick={() => {
                  setFilter(f.value)
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
            placeholder="Search name or email"
          />
        </>
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={UsersIcon} message="No users match" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Organisations</th>
                <th>Flags</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(u => (
                <tr key={u.id}>
                  <td>
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-secondary">{u.email}</div>
                  </td>
                  <td className="tabular-nums">{u.tenantCount}</td>
                  <td className="space-x-1">
                    {u.isGlobalAdmin && (
                      <span className="badge badge-sm badge-info">global admin</span>
                    )}
                    {u.blockedAt && <span className="badge badge-sm badge-error">blocked</span>}
                    {!u.emailVerifiedAt && (
                      <span className="badge badge-sm badge-ghost">unverified</span>
                    )}
                  </td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(u.lastLoginAt)}</td>
                  <td className="text-right">
                    <Link to={`/admin/users/${u.id}`} className="btn btn-ghost btn-xs gap-1">
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
