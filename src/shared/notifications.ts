/**
 * In-app notification contracts (D13). Addressed to one user in one tenant; `data` carries the
 * type-specific payload (deep links, actor), typed here so the jsonb column and the API agree.
 */
import { z } from 'zod'
import { paginationQuerySchema } from './pagination'

export const notificationDataSchema = z.record(z.string(), z.unknown())
export type NotificationData = z.infer<typeof notificationDataSchema>

export const notificationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  data: notificationDataSchema,
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type Notification = z.infer<typeof notificationSchema>

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform(v => v === 'true')
    .optional(),
})
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>

export const unreadCountSchema = z.object({ count: z.number().int().min(0) })
export type UnreadCount = z.infer<typeof unreadCountSchema>

/** Mark specific notifications read, or everything (`all: true`). */
export const markNotificationsReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
])
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadRequestSchema>
