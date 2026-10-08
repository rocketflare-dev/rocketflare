/**
 * Memory (D36) — what the assistant learned from MY chats, and my switch for it. Every query is
 * the caller's own (`/api/memory` filters by owner), so there is no admin variant: a person's
 * private memory is not readable by anyone else, admins included. All of it sits behind the
 * `memory` flag, so callers check `session.features` before mounting anything that uses these.
 */
import {
  type MemoryListQuery,
  memoryEntityListResponseSchema,
  memoryForgetResponseSchema,
  memoryListResponseSchema,
  memorySettingsSchema,
} from '@rocketflare/shared/ai/memory'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export type MemoryFilters = Partial<Pick<MemoryListQuery, 'page' | 'pageSize' | 'q'>> & {
  includeHistorical?: boolean
}

export function useMemories(filters: MemoryFilters = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.memory.list(filters),
    queryFn: () =>
      api.get(
        `/api/memory${toSearchParams({
          ...filters,
          includeHistorical: filters.includeHistorical ? 'true' : undefined,
        })}`,
        { schema: memoryListResponseSchema }
      ),
    placeholderData: keepPreviousData,
    enabled,
  })
}

export function useMemoryEntities(enabled = true) {
  return useQuery({
    queryKey: queryKeys.memory.entities,
    queryFn: () => api.get('/api/memory/entities', { schema: memoryEntityListResponseSchema }),
    enabled,
  })
}

export function useMemorySettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.memory.settings,
    queryFn: () => api.get('/api/memory/settings', { schema: memorySettingsSchema }),
    enabled,
  })
}

export function useUpdateMemorySettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put('/api/memory/settings', { enabled }, { schema: memorySettingsSchema }),
    onSuccess: data => queryClient.setQueryData(queryKeys.memory.settings, data),
  })
}

export function useForgetMemory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/memory/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory.all }),
  })
}

export function useForgetAllMemories() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete('/api/memory', undefined, { schema: memoryForgetResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory.all }),
  })
}
