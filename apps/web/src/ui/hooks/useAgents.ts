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
  type AgentRunStatus,
  agentListResponseSchema,
  agentRunSchema,
  agentRunWithEventsSchema,
  type CreateAgentRunRequest,
  createAgentRunResponseSchema,
  isRunActive,
} from '@gmgo/shared/ai/agents'
import { ERROR_CODES } from '@gmgo/shared/errors'
import { paginatedResponse } from '@gmgo/shared/pagination'
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

/** `refetchInterval` for a run: poll while it still owes an answer, stop once it settles. */
export function runPollInterval(status: AgentRunStatus | undefined): number | false {
  return status && isRunActive(status) ? RUN_POLL_MS : false
}

/** 503 from `POST /api/agents/runs`: the `AGENT_RUN_WORKFLOW` binding is missing. */
export function isAgentRunsNotConfigured(error: unknown): boolean {
  return error instanceof ApiError && error.code === ERROR_CODES.agentRunsNotConfigured
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
    // A page with a live run keeps itself fresh even when the socket is down.
    refetchInterval: q =>
      q.state.data?.items.some(run => isRunActive(run.status)) ? RUN_POLL_MS : false,
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
