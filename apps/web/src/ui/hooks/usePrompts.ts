/**
 * Prompt registry + tenant overrides (D17): `GET /api/ai/prompts` lists every registry entry with
 * its override and effective text; `PUT /:key` sets an override, `DELETE /:key` reverts to the
 * default. Both mutations answer with the refreshed `PromptWithResolved`. Members `read Prompt`,
 * admins `manage`.
 */
import {
  promptListResponseSchema,
  promptWithResolvedSchema,
  type UpdatePromptRequest,
} from '@gmgo/shared/ai/prompts'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function promptsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.ai.prompts,
    queryFn: () => api.get('/api/ai/prompts', { schema: promptListResponseSchema }),
  })
}

export function usePrompts() {
  return useQuery(promptsQueryOptions())
}

export function useUpdatePrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, ...body }: UpdatePromptRequest & { key: string }) =>
      api.put(`/api/ai/prompts/${encodeURIComponent(key)}`, body, {
        schema: promptWithResolvedSchema,
        showSuccessToast: true,
        successMessage: 'Prompt saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.prompts }),
  })
}

export function useClearPrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (key: string) =>
      api.delete(`/api/ai/prompts/${encodeURIComponent(key)}`, undefined, {
        schema: promptWithResolvedSchema,
        showSuccessToast: true,
        successMessage: 'Prompt reset to default',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.prompts }),
  })
}
