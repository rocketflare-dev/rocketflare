/**
 * Activity log writer (D19). Every write route appends one row through `defer(() =>
 * recordActivity(...))` — fire-and-forget via `waitUntil`, so a failed audit write is logged, never
 * surfaced. Also called inside transactions (tenant create) where the caller passes the `tx`.
 */
import type { ActivityMetadata } from '@rocketflare/shared/activity'
import type { Database } from '../../db/client'
import { activityEvents } from '../../db/schema'

export interface ActivityInput {
  tenantId: string
  userId: string | null
  /** Dotted event name, e.g. `member.invited`, `api_key.created`. */
  type: string
  subjectType?: string | null
  subjectId?: string | null
  metadata?: ActivityMetadata
}

export async function recordActivity(db: Database, input: ActivityInput): Promise<void> {
  await db.insert(activityEvents).values({
    tenantId: input.tenantId,
    userId: input.userId,
    type: input.type,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    metadata: input.metadata ?? {},
  })
}
