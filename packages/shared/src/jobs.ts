/**
 * Background job contracts for `JOBS_QUEUE` (D7). One discriminated union on `type`; the producer
 * (`apps/web/src/api/services/jobs.ts`) validates a `JobInput` and stamps the envelope, the consumer
 * (`apps/web/src/api/queues/jobs.ts`) parses `jobEnvelopeSchema` from `message.body` and rejects
 * anything that does not match (acked, never retried — a poison message cannot loop).
 *
 * Versioning: the `type` string IS the version seam. A breaking payload change ships as a new type
 * (`email.send.v2`) with its own handler while the old one keeps draining in-flight messages; the
 * old type is removed once the queue is empty of it.
 *
 * The variants are DATA (D31): `CORE_JOB_VARIANTS` below plus whatever the installed plugins
 * declare, so `jobInputSchema`, `jobEnvelopeSchema`, `JobType` and `JOB_TYPES` are all DERIVED from
 * one list rather than four hand-kept ones that can disagree about what a job is.
 */
import { z } from 'zod'
import { activityMetadataSchema } from './activity'
import { type DeclaredBy, type SHARED_PLUGINS, sharedPlugins } from './plugins'

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

/** Index (chunk + embed) a `documents` row too large to do inline at ingest (D18). */
export const documentIndexPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
})
export type DocumentIndexPayload = z.infer<typeof documentIndexPayloadSchema>

/** Convert an uploaded file (R2 original → text via Workers AI `toMarkdown`) then index it (D18). */
export const documentConvertPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
})
export type DocumentConvertPayload = z.infer<typeof documentConvertPayloadSchema>

/**
 * Fold a conversation's trimmed-off prefix into its rolling summary (D17). The payload carries ids
 * only: the handler recomputes the window from the database, so a message enqueued two turns ago
 * still summarises the right thing.
 */
export const chatCompactPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  conversationId: z.string().uuid(),
  /**
   * Summarise whatever is pending, however little. The automatic path waits for
   * `CHAT_COMPACTION_MIN_CHARS` of uncovered material, because the window slides by a message or
   * two per turn and a model call per sentence costs more than the problem it solves. A person who
   * asked for a summary has already decided it is worth one call — and an optional field is used
   * rather than a new job type because an old consumer reading it as absent behaves exactly as it
   * does today.
   */
  force: z.boolean().optional(),
})
export type ChatCompactPayload = z.infer<typeof chatCompactPayloadSchema>

/**
 * Delete what a deleted tenant left OUTSIDE Postgres (R2 objects, a plugin's own out-of-database
 * state). The tenant row is already gone when this is enqueued — the FK cascade took it — so the
 * payload has to carry everything the purge needs: nothing can be looked up afterwards. `tenantSlug`
 * is carried for the log line alone, because after the delete there is no row left to name.
 */
export const tenantPurgePayloadSchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string().max(63).optional(),
})
export type TenantPurgePayload = z.infer<typeof tenantPurgePayloadSchema>

// ---- Envelope ------------------------------------------------------------------------------

/**
 * The kit's own variants. A plugin adds its own through `SharedPlugin.jobs`, so this list stays
 * the KIT's and an app that deletes a feature deletes its line here and nothing else.
 */
export const CORE_JOB_VARIANTS = [
  z.object({ type: z.literal('email.send'), payload: emailSendPayloadSchema }),
  z.object({ type: z.literal('activity.record'), payload: activityRecordPayloadSchema }),
  z.object({ type: z.literal('document.index'), payload: documentIndexPayloadSchema }),
  z.object({ type: z.literal('document.convert'), payload: documentConvertPayloadSchema }),
  z.object({ type: z.literal('chat.compact'), payload: chatCompactPayloadSchema }),
  z.object({ type: z.literal('tenant.purge'), payload: tenantPurgePayloadSchema }),
] as const

type PluginJobVariant = NonNullable<DeclaredBy<(typeof SHARED_PLUGINS)[number], 'jobs'>>[number]

/**
 * Core first, then every installed plugin's variants, as ONE tuple.
 *
 * The spread of an array into a tuple literal is what keeps `z.discriminatedUnion` happy: the type
 * is `[core…, ...PluginVariant[]]`, still non-empty in the type system however many plugins are
 * installed, because the kit's own five lead it. With no plugins the tail is `never[]` and this is
 * exactly the list the kit had before.
 */
export const JOB_VARIANTS = [
  ...CORE_JOB_VARIANTS,
  // Iterated through the widened list (an EMPTY tuple indexes to `never`, and `never.jobs` is a
  // type error); the cast restores what the tuple above says those elements actually are.
  ...(sharedPlugins.flatMap(p => p.jobs ?? []) as PluginJobVariant[]),
] as const

/** What a caller hands to `enqueueJob` — the envelope fields are stamped by the producer. */
export const jobInputSchema = z.discriminatedUnion('type', [...JOB_VARIANTS])
export type JobInput = z.infer<typeof jobInputSchema>

const envelopeFields = {
  id: z.string().uuid(),
  /** ISO-8601; set once by the producer. */
  enqueuedAt: z.string().datetime(),
  /** Reserved for producers that re-enqueue by hand; the platform's count is `message.attempts`. */
  attempt: z.number().int().min(1).optional(),
}

type EnvelopeFields = typeof envelopeFields

/** One variant with the envelope fields folded in — what `.extend(envelopeFields)` returns. */
type WithEnvelope<T> =
  T extends z.ZodObject<infer Shape, infer Unknown, infer Catchall>
    ? z.ZodObject<Shape & EnvelopeFields, Unknown, Catchall>
    : never

/**
 * `.map()` over a tuple answers an ARRAY, and `z.discriminatedUnion` needs a non-empty tuple — so
 * the result is re-described with a mapped type, which preserves both the length and each variant's
 * own shape. The cast asserts nothing the line above does not already do.
 */
type Enveloped<T extends readonly unknown[]> = { [K in keyof T]: WithEnvelope<T[K]> }

/** The on-the-wire message body. Same discriminant as `jobInputSchema` plus the envelope. */
export const jobEnvelopeSchema = z.discriminatedUnion(
  'type',
  JOB_VARIANTS.map(variant => variant.extend(envelopeFields)) as unknown as Enveloped<
    typeof JOB_VARIANTS
  >
)
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>

/** Every job type this app knows, derived from the variants rather than kept beside them. */
export type JobType = JobEnvelope['type']

/** The kit's own types, without any plugin's — what the core handler table is checked against. */
export type CoreJobType = z.infer<(typeof CORE_JOB_VARIANTS)[number]>['type']

/** The same list at runtime, in declaration order. */
export const JOB_TYPES: readonly JobType[] = JOB_VARIANTS.map(
  variant => variant.shape.type.value as JobType
)

/** The envelope narrowed to one `type` — what a handler receives. */
export type JobOf<T extends JobType> = Extract<JobEnvelope, { type: T }>
