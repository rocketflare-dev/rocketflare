/**
 * `activity.record` (D7, D19): append an `activity_events` row a hot path chose to offload rather
 * than insert inline. Same writer the routes use (`recordActivity`), so the row shape cannot drift.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { recordActivity } from '../../services/activity'
import type { JobContext } from '../jobs'

export async function handleActivityRecord(
  job: JobOf<'activity.record'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, userId, type, subjectType, subjectId, metadata } = job.payload
  await recordActivity(ctx.db, {
    tenantId,
    userId: userId ?? null,
    type,
    subjectType,
    subjectId: subjectId ?? null,
    metadata,
  })
  ctx.logger.info({ tenantId, type }, 'activity.record: recorded')
}
