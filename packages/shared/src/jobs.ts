/**
 * Background job contracts for `JOBS_QUEUE` (D7). One discriminated union on `type`; the producer
 * (`apps/web/src/api/services/jobs.ts`) validates a `JobInput` and stamps the envelope, the consumer
 * (`apps/web/src/api/queues/jobs.ts`) parses `jobEnvelopeSchema` from `message.body` and rejects
 * anything that does not match (acked, never retried — a poison message cannot loop).
 *
 * Versioning: the `type` string IS the version seam. A breaking payload change ships as a new type
 * (`email.send.v2`) with its own handler while the old one keeps draining in-flight messages; the
 * old type is removed once the queue is empty of it.
 */
import { z } from 'zod'
import { activityMetadataSchema } from './activity'

export const JOB_TYPES = [
  'email.send',
  'activity.record',
  'example.ping',
  'document.index',
] as const
export type JobType = (typeof JOB_TYPES)[number]

// ---- Payloads ------------------------------------------------------------------------------

/** A fully rendered transactional email. `link` is the one URL the dev fallback logs loudly. */
export const emailSendPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(500),
  html: z.string().min(1),
  text: z.string().optional(),
  link: z.string().url().optional(),
  tenantId: z.string().uuid().optional(),
  /** Why it was sent (`invitation`, `access_request_decided`, …) — for logs and metrics. */
  reason: z.string().min(1).max(100),
})
export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>

/** An `activity_events` row a hot path chose not to insert inline. */
export const activityRecordPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable().optional(),
  type: z.string().min(1).max(100),
  subjectType: z.string().min(1).max(100),
  subjectId: z.string().max(200).nullable().optional(),
  metadata: activityMetadataSchema.optional(),
})
export type ActivityRecordPayload = z.infer<typeof activityRecordPayloadSchema>

/** The smoke-test job: logs and acks. Kept so the pipeline can be exercised end to end. */
export const examplePingPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  note: z.string().max(200).optional(),
})
export type ExamplePingPayload = z.infer<typeof examplePingPayloadSchema>

/** Index (chunk + embed) a `documents` row too large to do inline at ingest (D18). */
export const documentIndexPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
})
export type DocumentIndexPayload = z.infer<typeof documentIndexPayloadSchema>

// ---- Envelope ------------------------------------------------------------------------------

/** What a caller hands to `enqueueJob` — the envelope fields are stamped by the producer. */
export const jobInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email.send'), payload: emailSendPayloadSchema }),
  z.object({ type: z.literal('activity.record'), payload: activityRecordPayloadSchema }),
  z.object({ type: z.literal('example.ping'), payload: examplePingPayloadSchema }),
  z.object({ type: z.literal('document.index'), payload: documentIndexPayloadSchema }),
])
export type JobInput = z.infer<typeof jobInputSchema>

const envelopeFields = {
  id: z.string().uuid(),
  /** ISO-8601; set once by the producer. */
  enqueuedAt: z.string().datetime(),
  /** Reserved for producers that re-enqueue by hand; the platform's count is `message.attempts`. */
  attempt: z.number().int().min(1).optional(),
}

/** The on-the-wire message body. Same discriminant as `jobInputSchema` plus the envelope. */
export const jobEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ ...envelopeFields, type: z.literal('email.send'), payload: emailSendPayloadSchema }),
  z.object({
    ...envelopeFields,
    type: z.literal('activity.record'),
    payload: activityRecordPayloadSchema,
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('example.ping'),
    payload: examplePingPayloadSchema,
  }),
  z.object({
    ...envelopeFields,
    type: z.literal('document.index'),
    payload: documentIndexPayloadSchema,
  }),
])
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>

/** The envelope narrowed to one `type` — what a handler receives. */
export type JobOf<T extends JobType> = Extract<JobEnvelope, { type: T }>
