/**
 * Activity / audit event contracts (D13). The generic per-tenant log every mutation may append to,
 * and the example fact table for analytics. `metadata` is typed here so the jsonb column agrees.
 */
import { z } from 'zod'
import { paginationQuerySchema } from './pagination'

export const activityMetadataSchema = z.record(z.string(), z.unknown())
export type ActivityMetadata = z.infer<typeof activityMetadataSchema>

export const activityEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  /** Dotted event name, e.g. `member.invited`. */
  type: z.string(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  metadata: activityMetadataSchema,
  createdAt: z.coerce.date(),
  /** Resolved actor, when the route joins `users`. */
  actor: z.object({ name: z.string(), email: z.string().email() }).nullable().optional(),
})
export type ActivityEvent = z.infer<typeof activityEventSchema>

export const activityListQuerySchema = paginationQuerySchema.extend({
  type: z.string().trim().min(1).max(100).optional(),
  subjectType: z.string().trim().min(1).max(100).optional(),
  subjectId: z.string().trim().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>
