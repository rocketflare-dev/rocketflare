/**
 * The example HR domain's page: leave requests, a form to ask for one, and approve / reject for
 * whoever may manage them. Approving emits `example-hr.leave.approved`, which hands the person's
 * open leads in `example-sales` back to the pool.
 */
import {
  type CreateLeaveRequest,
  EXAMPLE_LEAVE_SUBJECT,
  leaveRequestListResponseSchema,
  leaveRequestSchema,
} from '@rocketflare/shared/example-hr/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, EmptyState, SectionPanel, usePermissions } from '@/plugins/api/ui'
import { leaveKeys } from '../query-keys'

function useLeaveRequests() {
  return useQuery({
    queryKey: leaveKeys.list(1),
    queryFn: () =>
      api.get('/api/example-hr/leave-requests?page=1', { schema: leaveRequestListResponseSchema }),
  })
}

function useLeaveMutations() {
  const queryClient = useQueryClient()
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: leaveKeys.all })
  const create = useMutation({
    mutationFn: (body: CreateLeaveRequest) =>
      api.post('/api/example-hr/leave-requests', body, { schema: leaveRequestSchema }),
    onSuccess,
  })
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api.post(
        `/api/example-hr/leave-requests/${id}/decision`,
        { decision },
        { schema: leaveRequestSchema }
      ),
    onSuccess,
  })
  return { create, decide }
}

export default function LeavePage() {
  const { can } = usePermissions()
  const requests = useLeaveRequests()
  const { create, decide } = useLeaveMutations()
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [reason, setReason] = useState('')
  const canDecide = can('manage', EXAMPLE_LEAVE_SUBJECT)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!startsOn || !endsOn) return
    create.mutate(
      { startsOn, endsOn, reason: reason.trim() },
      {
        onSuccess: () => {
          setStartsOn('')
          setEndsOn('')
          setReason('')
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Leave"
        description="An example app domain: apps/web/src/example-hr, wired by one line in app.ts."
      >
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <label className="text-sm">
            From
            <input
              type="date"
              className="input input-bordered input-sm block"
              value={startsOn}
              onChange={e => setStartsOn(e.target.value)}
            />
          </label>
          <label className="text-sm">
            To
            <input
              type="date"
              className="input input-bordered input-sm block"
              value={endsOn}
              onChange={e => setEndsOn(e.target.value)}
            />
          </label>
          <input
            className="input input-bordered input-sm min-w-48 flex-1"
            placeholder="Reason (optional)"
            value={reason}
            maxLength={500}
            onChange={e => setReason(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={create.isPending || !startsOn || !endsOn}
          >
            Ask for leave
          </button>
        </form>
      </SectionPanel>

      <SectionPanel title="Requests">
        {requests.data && requests.data.items.length === 0 ? (
          <EmptyState message="No leave requests yet" description="Ask for some above." />
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {requests.data?.items.map(r => (
              <li key={r.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <div>
                  <p className="font-medium">
                    {r.startsOn} to {r.endsOn}
                  </p>
                  <p className="text-muted">
                    {r.status}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </p>
                </div>
                {canDecide && r.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>
    </div>
  )
}
