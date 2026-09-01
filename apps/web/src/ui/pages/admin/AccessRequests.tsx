/**
 * Admin → Access requests (D9, D25): the sign-up review queue. Approving either adds the requester
 * to an existing organisation or mints a new one (the `new_org` branch is hidden in single mode);
 * rejecting takes an optional reason. One endpoint: `POST …/:id/decide` (`decideAccessRequestSchema`).
 */

import type { AccessRequest, AccessRequestStatus } from '@gmgo/shared/access-requests'
import { InboxArrowDownIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAdminAccessRequests } from '@/ui/hooks/useAdminAccessRequests'
import { formatDate } from '@/ui/lib/format'
import { ApproveRequestModal, RejectRequestModal } from './ApproveRequestModal'

const STATUS_TABS: { value: AccessRequestStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

const STATUS_BADGE: Record<AccessRequestStatus, string> = {
  pending: 'badge-warning',
  approved: 'badge-success',
  rejected: 'badge-ghost',
}

export default function AccessRequests() {
  const [status, setStatus] = useState<AccessRequestStatus>('pending')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useAdminAccessRequests({ status, q, page })
  const [approving, setApproving] = useState<AccessRequest | null>(null)
  const [rejecting, setRejecting] = useState<AccessRequest | null>(null)
  const items = data?.items ?? []

  return (
    <SectionPanel
      flush
      title="Access requests"
      description="People who signed in without an invitation."
      actions={
        <>
          <div role="tablist" className="tabs tabs-box tabs-sm">
            {STATUS_TABS.map(tab => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                className={`tab ${status === tab.value ? 'tab-active' : ''}`}
                onClick={() => {
                  setStatus(tab.value)
                  setPage(1)
                }}
              >
                {tab.label}
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
            placeholder="Search email"
          />
        </>
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={InboxArrowDownIcon}
          message={`No ${status} requests`}
          description={
            status === 'pending'
              ? 'Sign-ups without an invitation land here for review.'
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table data-table-prose">
            <thead>
              <tr>
                <th>Requester</th>
                <th>Wants to join</th>
                <th>Requested</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(request => (
                <tr key={request.id}>
                  <td>
                    <div className="font-medium">{request.email}</div>
                    {request.message && (
                      <div className="text-xs text-secondary italic mt-1">“{request.message}”</div>
                    )}
                  </td>
                  <td className="text-secondary">
                    {request.requestedTenantName ??
                      (request.requestedTenantId ? 'a specific organisation' : '—')}
                  </td>
                  <td className="text-secondary whitespace-nowrap">
                    {formatDate(request.createdAt)}
                  </td>
                  <td>
                    <span className={`badge badge-sm ${STATUS_BADGE[request.status]}`}>
                      {request.status}
                    </span>
                    {request.decidedAt && (
                      <div className="text-xs text-muted mt-1">{formatDate(request.decidedAt)}</div>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {request.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-xs"
                          onClick={() => setApproving(request)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs ml-1"
                          onClick={() => setRejecting(request)}
                        >
                          Reject
                        </button>
                      </>
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
      {approving && <ApproveRequestModal request={approving} onClose={() => setApproving(null)} />}
      {rejecting && <RejectRequestModal request={rejecting} onClose={() => setRejecting(null)} />}
    </SectionPanel>
  )
}
