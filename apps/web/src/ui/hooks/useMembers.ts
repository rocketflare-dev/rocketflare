/** Tenant members (D10, D13): `GET /api/members`, role change, removal. Admin-level surface. */
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  memberSchema,
  type TenantRole,
  type UpdateMemberRoleRequest,
} from '@rocketflare/shared/tenants'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const membersResponseSchema = paginatedResponse(memberSchema)

export interface MembersFilters {
  page?: number
  pageSize?: number
}

export function membersQueryOptions(filters: MembersFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.members.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/members${toSearchParams(filters)}`, { schema: membersResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function useMembers(filters: MembersFilters = {}) {
  return useQuery(membersQueryOptions(filters))
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) =>
      api.patch(`/api/members/${userId}`, { role } satisfies UpdateMemberRoleRequest, {
        schema: memberSchema,
        showSuccessToast: true,
        successMessage: 'Role updated',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members.all }),
  })
}

export function useRemoveMember() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/api/members/${userId}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Member removed',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members.all }),
  })
}
