/** `/activity` (D13): the tenant's audit log, admin-level, paginated. */
import { ClockIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PageHeader,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useActivity } from '@/ui/hooks/useActivity'
import { formatDateTime } from '@/ui/lib/format'

export default function Activity() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useActivity({ page })
  const items = data?.items ?? []

  return (
    <div className="max-w-4xl">
      <PageHeader title="Activity" description="Who did what in this organisation." />
      <SectionPanel flush>
        {isLoading ? (
          <div className="p-5">
            <SkeletonRows rows={5} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ClockIcon} message="No activity yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Subject</th>
                </tr>
              </thead>
              <tbody>
                {items.map(event => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap text-secondary">
                      {formatDateTime(event.createdAt)}
                    </td>
                    <td>
                      <code className="text-xs">{event.type}</code>
                    </td>
                    <td>
                      {event.actor ? (
                        <span title={event.actor.email}>{event.actor.name}</span>
                      ) : (
                        <span className="text-muted">system</span>
                      )}
                    </td>
                    <td className="text-secondary">
                      {event.subjectType ? (
                        <>
                          {event.subjectType}
                          {event.subjectId && (
                            <span className="text-muted font-mono text-xs">
                              {' '}
                              {event.subjectId.slice(0, 8)}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
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
    </div>
  )
}
