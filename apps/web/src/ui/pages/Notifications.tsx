/** `/notifications` (D13): the full list, unread filter, mark one / mark all read, paginated. */
import { BellSlashIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useMarkNotificationsRead, useNotifications } from '@/ui/hooks/useNotifications'
import { formatDateTime } from '@/ui/lib/format'

export default function Notifications() {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useNotifications({
    page,
    unreadOnly: unreadOnly || undefined,
  })
  const markRead = useMarkNotificationsRead()
  const items = data?.items ?? []

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Notifications"
        actions={
          <>
            <div role="tablist" className="tabs tabs-box tabs-sm">
              <button
                type="button"
                role="tab"
                className={`tab ${unreadOnly ? '' : 'tab-active'}`}
                onClick={() => {
                  setUnreadOnly(false)
                  setPage(1)
                }}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                className={`tab ${unreadOnly ? 'tab-active' : ''}`}
                onClick={() => {
                  setUnreadOnly(true)
                  setPage(1)
                }}
              >
                Unread
              </button>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all read
            </button>
          </>
        }
      />
      <SectionPanel flush>
        {isLoading ? (
          <div className="p-5">
            <SkeletonRows rows={4} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={BellSlashIcon}
            message={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          />
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {items.map(n => (
              <li
                key={n.id}
                className={`flex items-start gap-3 px-5 py-3 ${n.readAt ? '' : 'bg-[color:var(--surface-active)]'}`}
              >
                <span
                  className={`mt-2 w-2 h-2 rounded-full shrink-0 ${n.readAt ? 'bg-transparent' : 'bg-primary'}`}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{n.title}</div>
                  {n.body && <div className="text-sm text-secondary">{n.body}</div>}
                  <div className="text-xs text-muted mt-0.5">{formatDateTime(n.createdAt)}</div>
                </div>
                {!n.readAt && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => markRead.mutate({ ids: [n.id] })}
                  >
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
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
    </div>
  )
}
