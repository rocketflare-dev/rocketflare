/**
 * `event.deliver` (D42): hand ONE recorded plugin event to ONE subscriber. `ctx.emit` queued one of
 * these per subscriber, so a failure here retries this subscriber and nobody else.
 *
 * The payload is re-read from `plugin_events` under the job's tenant and re-validated against the
 * declaration — never carried in the message. Every way the delivery cannot happen is
 * acknowledged and logged rather than retried, because retrying cannot change it: the row was
 * pruned (past `EVENTS_RETENTION_DAYS`) or belongs to another tenant, the event is no longer
 * declared, the stored payload no longer parses, the subscriber was renamed or removed by a
 * deploy, or the subscriber refused with a 4xx (`ValidationError`, `agent_not_bindable`). A 429
 * (cap, budget), a 503 and any other throw retry with the consumer's backoff.
 *
 * Log lines carry the event's name and id and the subscriber's id — never the payload, which may
 * hold a form's personal data.
 */
import type { JobOf } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import { pluginEvents } from '../../../db/schema/plugin-events'
import { eventDefinition } from '../../services/events/registry'
import { eventSubscribers } from '../../services/events/subscribers'
import { ApiError } from '../../utils/core/errors'
import type { JobContext } from '../jobs'

/** A refusal a retry cannot change: acknowledged. 408/429 are load, and retry. */
function isFinalRefusal(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.statusCode >= 400 &&
    err.statusCode < 500 &&
    err.statusCode !== 408 &&
    err.statusCode !== 429
  )
}

export async function handleEventDeliver(
  job: JobOf<'event.deliver'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, eventId, subscriber } = job.payload
  const log = { eventId, subscriber }
  const [row] = await ctx.db
    .select()
    .from(pluginEvents)
    .where(and(eq(pluginEvents.id, eventId), eq(pluginEvents.tenantId, tenantId)))
  if (!row) {
    ctx.logger.warn(log, 'event.deliver: the event is gone (pruned or purged); acknowledging')
    return
  }
  const definition = eventDefinition(row.name)
  const target = eventSubscribers().find(s => s.id === subscriber && s.event === row.name)
  if (!definition || !target) {
    ctx.logger.warn(
      { ...log, event: row.name, declared: Boolean(definition) },
      'event.deliver: no such event or subscriber in this deploy; acknowledging'
    )
    return
  }
  const parsed = definition.schema.safeParse(row.payload)
  if (!parsed.success) {
    ctx.logger.error(
      { ...log, event: row.name, paths: parsed.error.issues.map(i => i.path.join('.')) },
      'event.deliver: the stored payload no longer matches its declaration; acknowledging'
    )
    return
  }
  try {
    await target.deliver(
      {
        id: row.id,
        name: row.name as never,
        tenantId: row.tenantId,
        payload: parsed.data as never,
        occurredAt: row.createdAt,
      },
      ctx
    )
  } catch (err) {
    if (!isFinalRefusal(err)) throw err
    ctx.logger.warn(
      { ...log, event: row.name, status: err.statusCode, code: err.code },
      'event.deliver: the subscriber refused; acknowledging'
    )
    return
  }
  ctx.logger.info({ ...log, event: row.name }, 'event.deliver: delivered')
}
