/**
 * Feature flags for the global-admin area (D30).
 *
 * Two layers are visible here and the page has to keep them apart: `availableInEnvironment` is
 * config (a redeploy moves it), everything else is rollout state (a click moves it). A flag that is
 * environment-disabled is off for everyone whatever its state says, so the page must show that
 * rather than a percentage nobody is receiving.
 *
 * Overrides are multi-tenant only: with one organisation the platform state already IS that
 * organisation's answer, and the routes answer 404 `tenancy_mode_single`.
 */
import {
  featureFlagListResponseSchema,
  type SetTenantOverrideRequest,
  tenantFeatureOverrideListResponseSchema,
  type UpdateFeatureFlagRequest,
} from '@rocketflare/shared/features'
import type { FeatureName } from '@rocketflare/shared/permissions'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function featureFlagsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.admin.featureFlags.all,
    queryFn: () => api.get('/api/admin/feature-flags', { schema: featureFlagListResponseSchema }),
  })
}

export function useFeatureFlags() {
  return useQuery(featureFlagsQueryOptions())
}

export function useFlagOverrides(key: FeatureName, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.admin.featureFlags.overrides(key),
    queryFn: () =>
      api.get(`/api/admin/feature-flags/${key}/overrides`, {
        schema: tenantFeatureOverrideListResponseSchema,
      }),
    enabled,
  })
}

export function useUpdateFeatureFlag(key: FeatureName) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateFeatureFlagRequest) =>
      api.patch(`/api/admin/feature-flags/${key}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.featureFlags.all })
    },
  })
}

export function useSetTenantOverride(key: FeatureName) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, ...body }: SetTenantOverrideRequest & { tenantId: string }) =>
      api.put(`/api/admin/feature-flags/${key}/overrides/${tenantId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.featureFlags.all })
    },
  })
}

export function useClearTenantOverride(key: FeatureName) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tenantId: string) =>
      api.delete(`/api/admin/feature-flags/${key}/overrides/${tenantId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.featureFlags.all })
    },
  })
}
