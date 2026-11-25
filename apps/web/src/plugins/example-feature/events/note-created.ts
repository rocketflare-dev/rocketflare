/**
 * The plugin's own subscriber to `example-feature.note.created` (D42): it writes the audit row.
 *
 * A handler is a JOB in every respect — its own delivery per event, await everything, throw to
 * retry — and is written against `EventCtx`, which `eventCtx` adapts once at the registration
 * boundary (`../index.ts`). The context is BOUND to the event's tenant: nothing on it takes a
 * tenant id, and every query here carries `ctx.tenantId`.
 *
 * **Idempotent on the event**: delivery is at least once, so it checks for its own row first. The
 * agent the event starts needs no handler at all — that is the agent's `triggers`.
 */
import type { ExampleNoteCreatedPayload } from '@rocketflare/shared/plugins/example-feature/index'
import {
  EXAMPLE_NOTE_CREATED_EVENT,
  EXAMPLE_NOTE_SUBJECT,
} from '@rocketflare/shared/plugins/example-feature/index'
import { and, eq } from 'drizzle-orm'
import { activityEvents } from '@/db/schema/kit'
import type { DeliveredEvent, EventCtx, EventHandler } from '@/plugins/api'
import { eventCtx, recordActivity } from '@/plugins/api'

/** The activity type the handler records. */
export const EXAMPLE_NOTE_CREATED_ACTIVITY = 'example_note.created'

export async function recordNoteCreated(
  event: { id: string; payload: ExampleNoteCreatedPayload },
  ctx: EventCtx
): Promise<void> {
  const [existing] = await ctx.db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.tenantId, ctx.tenantId),
        eq(activityEvents.type, EXAMPLE_NOTE_CREATED_ACTIVITY),
        eq(activityEvents.subjectId, event.payload.noteId)
      )
    )
    .limit(1)
  if (existing) return
  await recordActivity(ctx.db, {
    tenantId: ctx.tenantId,
    userId: event.payload.ownerUserId,
    type: EXAMPLE_NOTE_CREATED_ACTIVITY,
    subjectType: EXAMPLE_NOTE_SUBJECT,
    subjectId: event.payload.noteId,
    metadata: { eventId: event.id },
  })
}

/** What `ServerPlugin.eventHandlers` registers. `name` is part of the delivery's id: never rename it. */
export const exampleNoteCreatedHandler: EventHandler<typeof EXAMPLE_NOTE_CREATED_EVENT> = {
  event: EXAMPLE_NOTE_CREATED_EVENT,
  name: 'record-activity',
  handle: (event: DeliveredEvent<typeof EXAMPLE_NOTE_CREATED_EVENT>, ctx) =>
    recordNoteCreated(event, eventCtx(ctx)),
}
