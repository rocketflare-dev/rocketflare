/** Tenant API keys (D12, D13). The plaintext exists only in the create response — show it once. */
import {
  apiKeySchema,
  type CreateApiKeyRequest,
  createApiKeyResponseSchema,
} from '@rocketflare/shared/api-keys'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const apiKeysResponseSchema = paginatedResponse(apiKeySchema)

export interface ApiKeysFilters {
  page?: number
  pageSize?: number
}

export function apiKeysQueryOptions(filters: ApiKeysFilters = {}) {
  return queryOptions({
    queryKey: [...queryKeys.keys.all, cleanFilters(filters)] as const,
    queryFn: () =>
      api.get(`/api/keys${toSearchParams(filters)}`, { schema: apiKeysResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function useApiKeys(filters: ApiKeysFilters = {}) {
  return useQuery(apiKeysQueryOptions(filters))
}

export function useCreateApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateApiKeyRequest) =>
      api.post('/api/keys', body, { schema: createApiKeyResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.keys.all }),
  })
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/keys/${id}`, undefined, {
        showSuccessToast: true,
        successMessage: 'API key revoked',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.keys.all }),
  })
}
