/** Global-admin review queue (D9, D25): list + the one `decide` endpoint (approve/reject). */
import {
  type AccessRequestStatus,
  accessRequestSchema,
  type DecideAccessRequest,
} from '@rocketflare/shared/access-requests'
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

export const accessRequestsResponseSchema = paginatedResponse(accessRequestSchema)

export interface AccessRequestsFilters {
  page?: number
  pageSize?: number
  status?: AccessRequestStatus
  q?: string
}

export function adminAccessRequestsQueryOptions(filters: AccessRequestsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.admin.accessRequests.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/admin/access-requests${toSearchParams(filters)}`, {
        schema: accessRequestsResponseSchema,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useAdminAccessRequests(filters: AccessRequestsFilters = {}) {
  return useQuery(adminAccessRequestsQueryOptions(filters))
}

export function useDecideAccessRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: DecideAccessRequest }) =>
      api.post<unknown>(`/api/admin/access-requests/${id}/decide`, decision, {
        showSuccessToast: true,
        successMessage: decision.decision === 'approve' ? 'Request approved' : 'Request rejected',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.all }),
  })
}
