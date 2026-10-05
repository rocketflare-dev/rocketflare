/**
 * Memory (D36): atomic facts the assistant learned from a person's own conversations, each with
 * the time it is ABOUT (`occurredStart`/`occurredEnd`) as well as the time it was SAID
 * (`mentionedAt`), linked to the entities it names, and recalled across threads by the
 * `recall_memory` tool. Ported in shape from Hindsight's retain/recall model, with the security
 * model the kit's tenancy and groups (D29) already give.
 *
 * Three rules every shape here encodes:
 *
 * - **A memory has an audience, and `private` is never bypassed.** `private` is its owner only —
 *   an admin's chat must not pull another person's memories into its context, so the D29 admin
 *   bypass does not apply. `groups` and `tenant` behave exactly like a document's visibility; the
 *   kit writes only `private` rows today (phase 1), and the other two exist so knowledge derived
 *   from documents can inherit their audience later without a migration.
 * - **A memory says where it came from.** The conversation it was learned from, so deleting that
 *   conversation deletes what was learned from it.
 * - **Superseded is not deleted.** "I live in Lisbon" replacing "I live in Porto" invalidates the
 *   old fact (`invalidatedAt`, `supersededById`) rather than erasing it, so "where did I live
 *   before?" is still answerable with `includeHistorical`.
 */
import { z } from 'zod'
import { paginatedResponse } from '../pagination'

export const MEMORY_VISIBILITIES = ['private', 'groups', 'tenant'] as const
export const memoryVisibilitySchema = z.enum(MEMORY_VISIBILITIES)
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>

/**
 * What kind of thing a fact is. `event` happened at a time; `preference` is a standing like,
 * dislike or way of working; `fact` is anything else that is true until it is not.
 */
export const MEMORY_KINDS = ['event', 'preference', 'fact'] as const
export const memoryKindSchema = z.enum(MEMORY_KINDS)
export type MemoryKind = z.infer<typeof memoryKindSchema>

/** One fact's text. Atomic and self-contained — a sentence, not a paragraph. */
export const MEMORY_TEXT_MAX_CHARS = 500
/** Entity names per fact; more than this is a fact that should have been split. */
export const MEMORY_ENTITIES_MAX = 8
export const MEMORY_ENTITY_NAME_MAX = 100
/** Facts one retain pass may write — a cap on what a single runaway extraction can cost. */
export const MEMORY_FACTS_PER_RETAIN_MAX = 20
/** Hits `recall_memory` returns when the model does not say, and the most it may ask for. */
export const MEMORY_RECALL_DEFAULT_LIMIT = 10
export const MEMORY_RECALL_MAX_LIMIT = 30
/**
 * Below this much new USER text a retain pass is a no-op: "thanks!" holds nothing worth a model
 * call. The watermark does not move, so the text is reconsidered with the next turn's.
 */
export const MEMORY_RETAIN_MIN_CHARS = 40

/** The tool name, in shared so the UI can recognise its calls the way it does the knowledge tools. */
export const MEMORY_TOOLS = { recall: 'recall_memory' } as const

/** The key memory's per-person switch lives under in `tenant_user_settings.preferences`. */
export const MEMORY_PREFERENCE_KEY = 'memory'

export const memoryEntityRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
})
export type MemoryEntityRef = z.infer<typeof memoryEntityRefSchema>

export const memorySchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  kind: memoryKindSchema,
  visibility: memoryVisibilitySchema,
  /** When what it describes happened or began — null when the fact is not anchored in time. */
  occurredStart: z.coerce.date().nullable(),
  occurredEnd: z.coerce.date().nullable(),
  /** When it was said. Always present. */
  mentionedAt: z.coerce.date(),
  entities: z.array(memoryEntityRefSchema),
  sourceConversationId: z.string().uuid().nullable(),
  /** Set when a later fact replaced this one. */
  invalidatedAt: z.coerce.date().nullable(),
  supersededById: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
})
export type Memory = z.infer<typeof memorySchema>

/** An ISO date (`2026-03-01`) or date-time. Parsed as an instant; a bare date is UTC midnight. */
const isoInstantSchema = z
  .string()
  .trim()
  .refine(value => !Number.isNaN(Date.parse(value)), 'Expected an ISO date, e.g. 2026-03-01')

export const memoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Words to match in the fact text (full-text, not semantic). */
  q: z.string().trim().max(200).optional(),
  /** Only facts whose time overlaps `[from, to]` — `occurred*` when known, else `mentionedAt`. */
  from: isoInstantSchema.optional(),
  to: isoInstantSchema.optional(),
  /** Include facts a later one replaced. */
  includeHistorical: z
    .enum(['true', 'false'])
    .transform(value => value === 'true')
    .optional(),
})
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>

export const memoryListResponseSchema = paginatedResponse(memorySchema)
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>

export const memoryEntitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mentionCount: z.number().int().nonnegative(),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
})
export type MemoryEntity = z.infer<typeof memoryEntitySchema>

export const memoryEntityListResponseSchema = z.object({ items: z.array(memoryEntitySchema) })
export type MemoryEntityListResponse = z.infer<typeof memoryEntityListResponseSchema>

/** `DELETE /api/memory` — forget everything; the count says how much that was. */
export const memoryForgetResponseSchema = z.object({ deleted: z.number().int().nonnegative() })
export type MemoryForgetResponse = z.infer<typeof memoryForgetResponseSchema>

/**
 * `GET|PUT /api/memory/settings` — the person's own switch. `available` is the workspace's flag
 * (read-only here), `enabled` the person's choice; memory runs only when both are true.
 */
export const memorySettingsSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
})
export type MemorySettings = z.infer<typeof memorySettingsSchema>

export const updateMemorySettingsRequestSchema = z.object({ enabled: z.boolean() })
export type UpdateMemorySettingsRequest = z.infer<typeof updateMemorySettingsRequestSchema>

/** What a person's memory preference looks like inside `preferences`. Absent = enabled. */
export const memoryPreferenceSchema = z.object({ enabled: z.boolean() }).partial()

/** Whether a stored preferences object switches memory off. Tolerant: junk reads as "not off". */
export function memoryOptedOut(preferences: Record<string, unknown> | null | undefined): boolean {
  const parsed = memoryPreferenceSchema.safeParse(preferences?.[MEMORY_PREFERENCE_KEY])
  return parsed.success && parsed.data.enabled === false
}

export const memoryIdParamSchema = z.object({ id: z.string().uuid() })
