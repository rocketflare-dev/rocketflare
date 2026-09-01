/**
 * Per-agent model assignment (D17): `GET /api/ai/agent-models` lists EVERY registry prompt key
 * with its assignment (if any) and what `resolveChat` would pick right now — computed server-side
 * by the same planner the runtime uses, so this page can never disagree with a run. `PUT /:key`
 * pins a chat `ai_configs` row and/or a model; `DELETE /:key` reverts to the default (absence is
 * the default — never a sentinel). Members `read AiConfig`; `manage AiConfig` writes.
 */
import {
  type AgentModelAssignment,
  agentModelAssignmentSchema,
  agentModelsListResponseSchema,
  type UpsertAgentModelRequest,
} from '@rocketflare/shared/ai/agent-models'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function agentModelsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.ai.agentModels,
    queryFn: () => api.get('/api/ai/agent-models', { schema: agentModelsListResponseSchema }),
  })
}

export function useAgentModels() {
  return useQuery(agentModelsQueryOptions())
}

/** Send only what is set — the request schema insists on at least one of the two. */
export function useUpsertAgentModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ promptKey, ...body }: UpsertAgentModelRequest & { promptKey: string }) =>
      api.put<AgentModelAssignment>(`/api/ai/agent-models/${encodeURIComponent(promptKey)}`, body, {
        schema: agentModelAssignmentSchema,
        showSuccessToast: true,
        successMessage: 'Model assignment saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.agentModels }),
  })
}

export function useDeleteAgentModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (promptKey: string) =>
      api.delete(`/api/ai/agent-models/${encodeURIComponent(promptKey)}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Using the default model again',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.agentModels }),
  })
}
