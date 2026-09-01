/** Tenant activity log (D13): `GET /api/activity`, admin-level, paginated. */
import { activityEventSchema } from '@rocketflare/shared/activity'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const activityResponseSchema = paginatedResponse(activityEventSchema)

export interface ActivityFilters {
  page?: number
  pageSize?: number
  type?: string
}

export function activityQueryOptions(filters: ActivityFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.activity.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/activity${toSearchParams(filters)}`, { schema: activityResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function useActivity(filters: ActivityFilters = {}) {
  return useQuery(activityQueryOptions(filters))
}
