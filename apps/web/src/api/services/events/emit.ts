/**
 * `emitEvent` — the one implementation behind every context's `ctx.emit` (D42).
 *
 * The order is the contract: **validate → record → queue one delivery per subscriber → mark
 * dispatched.** The emitter never runs a handler (routes enqueue, never run), and the payload never
 * leaves Postgres: each `event.deliver` job carries the row id, the tenant and the subscriber's id.
 *
 * - An unknown name is a 400 `event_unknown`; a payload the declaration refuses is a 400
 *   `validation_failed` whose details are zod's issues (paths and messages — zod 4 copies no input
 *   value into an issue). The payload itself is never logged.
 * - A missing `JOBS_QUEUE` throws BEFORE the insert, so no event is recorded that nothing delivers.
 * - With an `idempotencyKey`, the partial unique index answers a second emit with the first row
 *   (`deduplicated`). A first emit that recorded and then failed to queue left `dispatched_at`
 *   NULL; the retry with the same key queues it then. Delivery is at least once either way, which
 *   is why every subscriber must be idempotent on `event.id`.
 * - No subscriber is not an error: the row is still the record (and what a later `bindable` start
 *   would need), and it is pruned like any other.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { JobInput } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { pluginEvents } from '../../../db/schema/plugin-events'
import { BadRequestError, ValidationError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import { enqueueJobs, type JobsQueue, requireJobsQueue } from '../jobs'
import { eventDefinition } from './registry'
import type { EmittedEvent } from './types'

export interface EmitEventInput {
  name: string
  tenantId: string
  payload: unknown
  idempotencyKey?: string
}

export async function emitEvent(
  db: Database,
  env: { JOBS_QUEUE?: JobsQueue | Queue | null },
  input: EmitEventInput,
  logger?: Pick<Logger, 'info'>
): Promise<EmittedEvent> {
  const definition = eventDefinition(input.name)
  if (!definition) {
    throw new BadRequestError(`Unknown event: ${input.name}`, ERROR_CODES.eventUnknown, {
      event: input.name,
    })
  }
  const parsed = definition.schema.safeParse(input.payload)
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid event payload')
  const queue = requireJobsQueue(env.JOBS_QUEUE as JobsQueue | null | undefined)

  const values = {
    tenantId: input.tenantId,
    name: definition.name,
    source: definition.source,
    payload: parsed.data,
    idempotencyKey: input.idempotencyKey ?? null,
  }
  let deduplicated = false
  let [row] = input.idempotencyKey
    ? await db.insert(pluginEvents).values(values).onConflictDoNothing().returning()
    : await db.insert(pluginEvents).values(values).returning()
  if (!row && input.idempotencyKey) {
    deduplicated = true
    ;[row] = await db
      .select()
      .from(pluginEvents)
      .where(
        and(
          eq(pluginEvents.tenantId, input.tenantId),
          eq(pluginEvents.name, definition.name),
          eq(pluginEvents.idempotencyKey, input.idempotencyKey)
        )
      )
  }
  if (!row) throw new Error('plugin_events: insert returned no row')
  if (deduplicated && row.dispatchedAt) return { eventId: row.id, deduplicated, deliveries: 0 }

  // Function-scope: the subscriber table reads the server barrel and the agent registry, and every
  // plugin reaches this module through `@/plugins/api` — a static import would close the cycle.
  const { subscribersFor } = await import('./subscribers')
  const subscribers = subscribersFor(definition.name)
  const jobs: JobInput[] = subscribers.map(s => ({
    type: 'event.deliver',
    payload: { tenantId: input.tenantId, eventId: row.id, subscriber: s.id },
  }))
  if (jobs.length > 0) await enqueueJobs(queue, jobs)
  await db
    .update(pluginEvents)
    .set({ dispatchedAt: new Date() })
    .where(and(eq(pluginEvents.id, row.id), eq(pluginEvents.tenantId, input.tenantId)))
  // Names and counts only: the payload is never a log line.
  logger?.info(
    { event: definition.name, eventId: row.id, deliveries: jobs.length, deduplicated },
    'event: emitted'
  )
  return { eventId: row.id, deduplicated, deliveries: jobs.length }
}
