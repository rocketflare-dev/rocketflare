/**
 * The active organisation (D13, D25): `GET/PATCH /api/tenant`, its settings, create (multi mode
 * only) and delete (owner, slug confirmation). Every mutation that changes what `/auth/session`
 * reports (name, slug, membership) also refreshes the session.
 *
 * Contract note: the bodies of `POST /api/tenants` and `DELETE /api/tenant` are unspecified;
 * create is parsed tolerantly (a session response switches into the new org; a bare tenant is
 * selected explicitly), delete simply refreshes the session and lets `ProtectedRoute` route.
 */
import { sessionResponseSchema } from '@gmgo/shared/auth'
import {
  tenantSettingsSchema,
  type UpdateTenantSettingsRequest,
} from '@gmgo/shared/tenant-settings'
import {
  type CreateTenantRequest,
  tenantSchema,
  type UpdateTenantRequest,
} from '@gmgo/shared/tenants'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'
import { navigateTo } from '@/ui/lib/navigation'
import { queryKeys } from '@/ui/lib/query-keys'

export function tenantQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.tenant.current,
    queryFn: () => api.get('/api/tenant', { schema: tenantSchema }),
  })
}

export function tenantSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.tenant.settings,
    queryFn: () => api.get('/api/tenant/settings', { schema: tenantSettingsSchema }),
  })
}

export function useTenant() {
  return useQuery(tenantQueryOptions())
}

export function useTenantSettings() {
  return useQuery(tenantSettingsQueryOptions())
}

export function useUpdateTenant() {
  const queryClient = useQueryClient()
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: (body: UpdateTenantRequest) =>
      api.patch('/api/tenant', body, {
        schema: tenantSchema,
        showSuccessToast: true,
        successMessage: 'Organisation updated',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tenant.all })
      await refresh()
    },
  })
}

export function useUpdateTenantSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateTenantSettingsRequest) =>
      api.patch('/api/tenant/settings', body, {
        schema: tenantSettingsSchema,
        showSuccessToast: true,
        successMessage: 'Settings saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tenant.settings }),
  })
}

/** Multi mode only (D25): creates an org owned by the caller and switches into it. */
export function useCreateTenant() {
  const { applySession, selectTenant } = useAuth()
  return useMutation({
    mutationFn: (body: CreateTenantRequest) =>
      api.post<unknown>('/api/tenants', body, {
        showSuccessToast: true,
        successMessage: `Created ${body.name}`,
      }),
    onSuccess: async result => {
      const asSession = sessionResponseSchema.safeParse(result)
      if (asSession.success) {
        applySession(asSession.data)
      } else {
        const asTenant = tenantSchema.safeParse(result)
        if (asTenant.success) await selectTenant(asTenant.data.id)
      }
      navigateTo('/', { replace: true })
    },
  })
}

/** Owner only, multi mode only (D25). `confirm` must equal the slug. */
export function useDeleteTenant() {
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: (confirm: string) =>
      api.delete(
        '/api/tenant',
        { confirm },
        {
          showSuccessToast: true,
          successMessage: 'Organisation deleted',
        }
      ),
    onSuccess: async () => {
      await refresh()
      navigateTo('/', { replace: true })
    },
  })
}
