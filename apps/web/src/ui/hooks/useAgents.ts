/**
 * Agent runs (D7, D8, D17, D20): the registry (`GET /api/agents`), runs paginated with filters
 * (`GET /runs`), one run with its durable events (`GET /runs/:id`), start (`POST /runs` → 202) and
 * cancel (`POST /runs/:id/cancel`). "DB is the truth, WebSocket is a nudge": the runs family root
 * is `agent-run`, the entity named by the server's `entity.changed` nudge, so `WebSocketProvider`
 * invalidates it generically; an active run ALSO polls every `RUN_POLL_MS` in case the socket is
 * down. Members see their own runs, admin+ every run — the route decides, the hook just lists.
 */
import {
  type AgentRun,
  type AgentRunEvent,
  type AgentRunStatus,
  agentListResponseSchema,
  agentRunEventSchema,
  agentRunSchema,
  agentRunWithEventsSchema,
  type CreateAgentRunRequest,
  createAgentRunResponseSchema,
} from '@rocketflare/shared/ai/agents'
import {
  type AgentRunInterrupt,
  agentRunInterruptSchema,
  interruptInboxItemSchema,
  type ResolveInterruptRequest,
} from '@rocketflare/shared/ai/interrupts'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError, api, showToast } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const agentRunsResponseSchema = paginatedResponse(agentRunSchema)

/** How often an open, still-active run re-reads its row + events without a nudge. */
export const RUN_POLL_MS = 3000

export interface AgentRunsFilters {
  page?: number
  pageSize?: number
  agentKey?: string
  status?: AgentRunStatus | ''
}

/**
 * Whether the SERVER still owes this run an answer — **narrower than `isRunActive`, on purpose**
 * (issue #17).
 *
 * `isRunActive` widened to include `awaiting_input`, because the exclusive index and "is this agent
 * busy?" genuinely include a parked run. Refreshing does not: a run parked on a question changes
 * only when a person answers it, and the server nudges that. Point a poll at `isRunActive` and a
 * parked run is re-fetched every three seconds **for the length of `AGENT_INTERRUPT_TIMEOUT`** —
 * days — by every open tab.
 */
export function runOwesAnswer(status: AgentRunStatus | undefined): boolean {
  return status === 'queued' || status === 'running'
}

/** `refetchInterval` for a run: poll while the server owes an answer, stop once it parks or settles. */
export function runPollInterval(status: AgentRunStatus | undefined): number | false {
  return runOwesAnswer(status) ? RUN_POLL_MS : false
}

/** 503 from `POST /api/agents/runs`: the `AGENT_RUN_WORKFLOW` binding is missing. */
export function isAgentRunsNotConfigured(error: unknown): boolean {
  return error instanceof ApiError && error.code === ERROR_CODES.agentRunsNotConfigured
}

/**
 * 409 from the resolve route: somebody else answered first (or the ask expired). **Information,
 * not an error** — the panel swaps to an info state and refetches, and the mutation suppresses its
 * toast, exactly as `isAgentRunsNotConfigured` does for the 503.
 */
export function isInterruptNotPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === ERROR_CODES.interruptNotPending
}

export function agentsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.agents.list,
    queryFn: () => api.get('/api/agents', { schema: agentListResponseSchema }),
    // The registry is code: it changes with a deploy, not with a click.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function agentRunsQueryOptions(filters: AgentRunsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.agentRuns.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/agents/runs${toSearchParams(filters)}`, { schema: agentRunsResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

/** The bare row (`?events=0`): one indexed read, for a header beside a list the page already has. */
export function agentRunRowQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.agentRuns.row(id),
    queryFn: () =>
      api.get(`/api/agents/runs/${encodeURIComponent(id)}?events=0`, { schema: agentRunSchema }),
  })
}

export function agentRunQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.agentRuns.detail(id),
    queryFn: () =>
      api.get(`/api/agents/runs/${encodeURIComponent(id)}`, { schema: agentRunWithEventsSchema }),
  })
}

export function useAgentList() {
  return useQuery(agentsQueryOptions())
}

export function useAgentRuns(filters: AgentRunsFilters = {}) {
  const query = useQuery({
    ...agentRunsQueryOptions(filters),
    // A page with a live run keeps itself fresh even when the socket is down. `runOwesAnswer`, not
    // `isRunActive`: a list holding one parked run would otherwise poll for days.
    refetchInterval: q =>
      q.state.data?.items.some(run => runOwesAnswer(run.status)) ? RUN_POLL_MS : false,
  })
  return query
}

export function useAgentRun(id: string | undefined) {
  return useQuery({
    ...agentRunQueryOptions(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: q => runPollInterval(q.state.data?.status),
  })
}

/** The bare row — for anything that wants the status without re-reading the whole log. */
export function useAgentRunRow(id: string | undefined) {
  return useQuery({
    ...agentRunRowQueryOptions(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: q => runPollInterval(q.state.data?.status),
  })
}

/**
 * `POST /api/agents/runs` → 202. `deduplicated: true` means an exclusive agent already had an
 * active run and THAT run came back — a success the caller navigates to, with a toast. The 503
 * `agent_runs_not_configured` is the page's business (it renders the explanatory empty state), so
 * the default error toast is off and re-applied for every other failure.
 */
export function useCreateAgentRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAgentRunRequest) =>
      api.post('/api/agents/runs', body, {
        schema: createAgentRunResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: run => {
      if (run.deduplicated) {
        showToast('This agent is already running — showing the existing run', 'info')
      }
      return queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns.all })
    },
    onError: error => {
      if (!isAgentRunsNotConfigured(error)) showToast(error.message, 'error')
    },
  })
}

/** `POST /api/agents/runs/:id/cancel` — answers the (possibly already settled) row. */
export function useCancelAgentRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<AgentRun>(`/api/agents/runs/${encodeURIComponent(id)}/cancel`, undefined, {
        schema: agentRunSchema,
        showSuccessToast: true,
        successMessage: 'Cancel requested',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns.all }),
  })
}

/**
 * Answer one of a run's asks (issue #17). **No optimistic write**: this is a decision with a side
 * effect at the other end, and a button that flips before the server agrees is a button that lies
 * when two people press it at once.
 *
 * `status` is the decision — `'resolved'` or `'cancelled'`, AG-UI's own `ResumeEntry` vocabulary —
 * and there is deliberately no `approved` boolean anywhere in the chain.
 *
 * The 409 is suppressed here because it is not a failure: the panel renders "someone else answered
 * this" and re-reads the run. Everything else toasts as usual.
 */
export function useResolveInterrupt(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      interruptId,
      ...body
    }: ResolveInterruptRequest & { interruptId: string }): Promise<AgentRunInterrupt> =>
      api.post(
        `/api/agents/runs/${encodeURIComponent(runId)}/interrupts/${encodeURIComponent(interruptId)}`,
        body,
        { schema: agentRunInterruptSchema, showErrorToast: false }
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns.all }),
    onError: error => {
      if (!isInterruptNotPending(error) && error instanceof ApiError && error.status !== 400) {
        showToast(error.message, 'error')
      }
    },
  })
}

/**
 * Send a note to a run in flight. It lands as an `agent_run_events` row, so the timeline shows it
 * where it happened and the runtime delivers it once — there is nothing client-side to remember.
 * A settled run answers 409 and the composer is not rendered for one.
 */
export function useSendSteering(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string): Promise<AgentRunEvent> =>
      api.post(
        `/api/agents/runs/${encodeURIComponent(runId)}/steering`,
        { text },
        {
          schema: agentRunEventSchema,
        }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns.all }),
  })
}

export const interruptInboxResponseSchema = paginatedResponse(interruptInboxItemSchema)

/**
 * How many asks are waiting on this person — the SideNav badge (issue #17).
 *
 * `pageSize: 1`, because only `pagination.total` is read. **Never polled**: it lives under
 * `['agent-run']`, which both the park (an `interrupt` event row) and the answer nudge, so the
 * number is live without a request every few seconds on every page in the app.
 */
export function useAwaitingInterruptCount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.agentRuns.awaiting,
    queryFn: () =>
      api.get('/api/agents/interrupts?status=pending&pageSize=1', {
        schema: interruptInboxResponseSchema,
      }),
    enabled,
    select: data => data.pagination.total,
  })
}
