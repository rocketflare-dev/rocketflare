/**
 * In-app notifications (D13): list, unread count for the bell, mark read. The list query uses the
 * `unreadOnly=true` parameter from `notificationListQuerySchema`. Phase 2's websocket store
 * invalidates `queryKeys.notifications.all`; until then the count polls quietly.
 */
import {
  type MarkNotificationsReadRequest,
  notificationSchema,
  unreadCountSchema,
} from '@rocketflare/shared/notifications'
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

export const notificationsResponseSchema = paginatedResponse(notificationSchema)

export interface NotificationsFilters {
  page?: number
  pageSize?: number
  unreadOnly?: boolean
}

export function notificationsQueryOptions(filters: NotificationsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.notifications.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/notifications${toSearchParams(filters)}`, {
        schema: notificationsResponseSchema,
      }),
    placeholderData: keepPreviousData,
  })
}

export function unreadCountQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.notifications.unreadCount,
    queryFn: () => api.get('/api/notifications/unread-count', { schema: unreadCountSchema }),
    refetchInterval: 60_000,
  })
}

export function useNotifications(filters: NotificationsFilters = {}) {
  return useQuery(notificationsQueryOptions(filters))
}

export function useUnreadCount() {
  return useQuery(unreadCountQueryOptions())
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: MarkNotificationsReadRequest) =>
      api.post('/api/notifications/read', body, { showErrorToast: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  })
}
