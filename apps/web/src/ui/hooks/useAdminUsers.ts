/** Global-admin view of people (D10): list, detail, the global-admin flag and blocking. */
import {
  type AdminUserListQuery,
  adminUserDetailSchema,
  adminUserListItemSchema,
  type BlockUserRequest,
  type SetGlobalAdminRequest,
} from '@gmgo/shared/admin'
import { paginatedResponse } from '@gmgo/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const adminUsersResponseSchema = paginatedResponse(adminUserListItemSchema)

export interface AdminUsersFilters {
  page?: number
  pageSize?: number
  q?: string
  filter?: AdminUserListQuery['filter']
}

export function adminUsersQueryOptions(filters: AdminUsersFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.admin.users.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/admin/users${toSearchParams(filters)}`, { schema: adminUsersResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function adminUserQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.admin.users.detail(id),
    queryFn: () => api.get(`/api/admin/users/${id}`, { schema: adminUserDetailSchema }),
    enabled: id.length > 0,
  })
}

export function useAdminUsers(filters: AdminUsersFilters = {}) {
  return useQuery(adminUsersQueryOptions(filters))
}

export function useAdminUser(id: string) {
  return useQuery(adminUserQueryOptions(id))
}

export function useSetGlobalAdmin(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (isGlobalAdmin: boolean) =>
      api.post(
        `/api/admin/users/${id}/global-admin`,
        { isGlobalAdmin } satisfies SetGlobalAdminRequest,
        {
          showSuccessToast: true,
          successMessage: isGlobalAdmin ? 'Granted global admin' : 'Revoked global admin',
        }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.all }),
  })
}

export function useBlockUser(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (blocked: boolean) =>
      api.post(`/api/admin/users/${id}/block`, { blocked } satisfies BlockUserRequest, {
        showSuccessToast: true,
        successMessage: blocked ? 'User blocked' : 'User unblocked',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.all }),
  })
}
