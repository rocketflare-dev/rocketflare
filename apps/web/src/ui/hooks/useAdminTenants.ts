/**
 * Global-admin view of organisations (D10, D25): list, detail, suspend, and "enter as support"
 * (a real `support` membership the org's owners can see). Contract note: the enter/leave
 * responses are unspecified; a session response is applied directly, anything else falls back to
 * an explicit select-tenant / session refresh.
 */
import {
  adminTenantDetailSchema,
  adminTenantListItemSchema,
  type SuspendTenantRequest,
} from '@rocketflare/shared/admin'
import { sessionResponseSchema } from '@rocketflare/shared/auth'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import type { TenantStatus } from '@rocketflare/shared/tenants'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { navigateTo } from '@/ui/lib/navigation'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const adminTenantsResponseSchema = paginatedResponse(adminTenantListItemSchema)

export interface AdminTenantsFilters {
  page?: number
  pageSize?: number
  q?: string
  status?: TenantStatus
}

export function adminTenantsQueryOptions(filters: AdminTenantsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.admin.tenants.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/admin/tenants${toSearchParams(filters)}`, {
        schema: adminTenantsResponseSchema,
      }),
    placeholderData: keepPreviousData,
  })
}

export function adminTenantQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.admin.tenants.detail(id),
    queryFn: () => api.get(`/api/admin/tenants/${id}`, { schema: adminTenantDetailSchema }),
    enabled: id.length > 0,
  })
}

export function useAdminTenants(filters: AdminTenantsFilters = {}) {
  return useQuery(adminTenantsQueryOptions(filters))
}

export function useAdminTenant(id: string) {
  return useQuery(adminTenantQueryOptions(id))
}

export function useSuspendTenant(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (suspended: boolean) =>
      api.post(`/api/admin/tenants/${id}/suspend`, { suspended } satisfies SuspendTenantRequest, {
        showSuccessToast: true,
        successMessage: suspended ? 'Organisation suspended' : 'Organisation reinstated',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.all }),
  })
}

export function useEnterSupport(id: string) {
  const { applySession, selectTenant } = useAuth()
  return useMutation({
    mutationFn: () => api.post<unknown>(`/api/admin/tenants/${id}/support/enter`),
    onSuccess: async result => {
      const asSession = sessionResponseSchema.safeParse(result)
      if (asSession.success) applySession(asSession.data)
      else await selectTenant(id)
      navigateTo('/', { replace: true })
    },
  })
}

export function useLeaveSupport(id: string) {
  const queryClient = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/admin/tenants/${id}/support/leave`, undefined, {
        showSuccessToast: true,
        successMessage: 'Support access removed',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants.all })
      await refresh()
    },
  })
}
