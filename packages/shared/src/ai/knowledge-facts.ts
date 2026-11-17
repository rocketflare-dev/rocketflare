/**
 * Knowledge facts (D43): typed facts extracted from documents and attached to the app's own
 * domain rows, or to a staging entity until a row exists.
 *
 * This file is the contract every consumer shares: what an app or plugin DECLARES about an entity
 * type (`EntityTypeDeclaration` — the server's `EntityTypeRegistration` adds the table it lives
 * in), the closed sets a fact moves through (`FACT_STATES`, `SOURCE_TRUST`), and the response
 * shapes the review endpoints, the entity card and the `lookup_facts` tool answer with.
 *
 * **A fact never decides by itself what it overrides.** Trust orders sources for the "which side
 * is preferred in an answer" question only; both sides of a conflict are always kept and cited
 * (`docs/plans/knowledge-base-review.md` §10, decisions 3 and 5).
 */
import { z } from 'zod'

// ── Entity type declarations ──────────────────────────────────────────────────────────────────

/**
 * An entity type: a bare snake_case name for the APP's own types (`customer`, `purchase_order`),
 * or `<plugin id>.<name>` for a plugin's (`example-feature.note`). A dot therefore always means
 * "a plugin owns this", so an app type can never collide with any plugin's, and `kit.` is never
 * a valid prefix (the kit core registers no domain types).
 */
export const ENTITY_TYPE_RE = /^(?:[a-z][a-z0-9-]*\.)?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/** A fact key: snake_case (`delivery_date`, `contact_name`). It is what extraction emits. */
export const FACT_KEY_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

export const entityTypeNameSchema = z
  .string()
  .regex(ENTITY_TYPE_RE, 'an entity type is `name` or `<plugin id>.name`, snake_case')
  .max(120)
export const factKeySchema = z.string().regex(FACT_KEY_RE, 'a fact key is snake_case').max(80)

/**
 * The facts an entity type may carry: a zod OBJECT whose keys are the fact keys and whose values
 * are the expected value schemas. `.describe('…')` on a value steers extraction — the description
 * travels into the JSON schema the extraction prompt renders (`entityFactsJsonSchema`). Every
 * value must be JSON-renderable: a date is `z.iso.date()` / `z.iso.datetime()`, never `z.date()`.
 */
export type EntityFactsSchema = z.ZodObject<z.ZodRawShape>

/** What an app or plugin declares about one entity type (the shared half of a registration). */
export interface EntityTypeDeclaration<F extends EntityFactsSchema = EntityFactsSchema> {
  type: string
  /** Shown to people: "Customer", "Order". */
  label: string
  facts: F
}

/**
 * Validates a declaration's shape. The facts object is checked structurally (it must be a zod
 * object, every key snake_case, and the whole thing renderable as JSON schema) because the
 * extraction prompt depends on all three.
 */
export const entityTypeSchema = z
  .object({
    type: entityTypeNameSchema,
    label: z.string().trim().min(1).max(80),
    facts: z.custom<EntityFactsSchema>(v => v instanceof z.ZodObject, {
      message: 'facts must be a zod object',
    }),
  })
  .superRefine((decl, ctx) => {
    const keys = Object.keys(decl.facts.shape)
    if (keys.length === 0) ctx.addIssue({ code: 'custom', message: 'facts declares no key' })
    for (const key of keys) {
      if (!FACT_KEY_RE.test(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['facts', key],
          message: 'fact key is not snake_case',
        })
      }
    }
    try {
      z.toJSONSchema(decl.facts)
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['facts'],
        message: `facts cannot be rendered as JSON schema: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })

/**
 * The JSON schema of a type's facts object — what the extraction prompt shows the model, with
 * each key's `.describe()` as its `description`.
 */
export function entityFactsJsonSchema(decl: EntityTypeDeclaration): Record<string, unknown> {
  return z.toJSONSchema(decl.facts) as Record<string, unknown>
}

/** The value schema for one key of a type, or undefined when the type declares no such key. */
export function factValueSchema(decl: EntityTypeDeclaration, key: string): z.ZodType | undefined {
  return Object.hasOwn(decl.facts.shape, key)
    ? (decl.facts.shape[key] as z.ZodType | undefined)
    : undefined
}

// ── Closed sets ───────────────────────────────────────────────────────────────────────────────

/**
 * Where a fact stands. `accepted` is used plainly; `unconfirmed` (low confidence) and
 * `conflicting` (another source disagrees) are used AND labelled — review never blocks retrieval;
 * `superseded` (a later fact replaced it, `supersededById`) and `rejected` (a person said "not
 * right") are kept for history and never answered with.
 */
export const FACT_STATES = [
  'accepted',
  'unconfirmed',
  'conflicting',
  'superseded',
  'rejected',
] as const
export const factStateSchema = z.enum(FACT_STATES)
export type FactState = z.infer<typeof factStateSchema>

/** The states that make a fact an open review item (and the partial index's predicate). */
export const OPEN_REVIEW_FACT_STATES = [
  'unconfirmed',
  'conflicting',
] as const satisfies readonly FactState[]

/** The states an answer may use — the open ones labelled. */
export const ANSWERABLE_FACT_STATES = [
  'accepted',
  'unconfirmed',
  'conflicting',
] as const satisfies readonly FactState[]

/**
 * What kind of source a fact came from, STRONGEST FIRST: a person stating it, a person's upload,
 * an agent's output, an integration's sync. Integration facts are weaker evidence than a person's
 * own upload (decision 5).
 */
export const SOURCE_TRUST = ['person', 'upload', 'agent', 'integration'] as const
export const sourceKindSchema = z.enum(SOURCE_TRUST)
export type SourceKind = z.infer<typeof sourceKindSchema>

/** Higher is more trusted: `person` 4 … `integration` 1. Compare with `>=`. */
export function trustRank(kind: SourceKind): number {
  return SOURCE_TRUST.length - SOURCE_TRUST.indexOf(kind)
}

/** `domain` = the entity is an app/plugin row; `staging` = a `knowledge_entities` row. */
export const ENTITY_KINDS = ['domain', 'staging'] as const
export const entityKindSchema = z.enum(ENTITY_KINDS)
export type EntityKind = z.infer<typeof entityKindSchema>

/**
 * A fact's visibility. `tenant` and `groups` mirror the source document's (a fact is read through
 * its document's grants); `private` is RESERVED for a later per-person memory plugin and never
 * written in this iteration.
 */
export const FACT_VISIBILITY = ['tenant', 'groups', 'private'] as const
export const factVisibilitySchema = z.enum(FACT_VISIBILITY)
export type FactVisibility = z.infer<typeof factVisibilitySchema>

// ── Entities ──────────────────────────────────────────────────────────────────────────────────

/** One candidate a resolver returns for a mention: a row id, its label, a score in [0, 1]. */
export const entityCandidateSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  score: z.number().min(0).max(1),
})
export type EntityCandidate = z.infer<typeof entityCandidateSchema>

/** A candidate stored on a staging entity for review: which kind of row it is, too. */
export const possibleMatchCandidateSchema = entityCandidateSchema.extend({
  kind: entityKindSchema,
})
export type PossibleMatchCandidate = z.infer<typeof possibleMatchCandidateSchema>

/** Where a staging entity was promoted to: a domain row of a registered type. */
export const entityRefSchema = z.object({ type: z.string(), id: z.string() })
export type EntityRef = z.infer<typeof entityRefSchema>

/** A `knowledge_entities` row as the API returns it (never its embedding). */
export const knowledgeEntitySchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  promotedTo: entityRefSchema.nullable(),
  mergedInto: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type KnowledgeEntity = z.infer<typeof knowledgeEntitySchema>

// ── Facts ─────────────────────────────────────────────────────────────────────────────────────

/** Where a fact was read: the document, the passage (null once re-chunked), the span, the quote. */
export const factSourceSchema = z.object({
  kind: sourceKindSchema,
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  chunkId: z.string().uuid().nullable(),
  charStart: z.number().int().nonnegative().nullable(),
  charEnd: z.number().int().nonnegative().nullable(),
  /** Verbatim text from the cited passage — extraction drops a candidate whose quote is not. */
  quote: z.string(),
})
export type FactSource = z.infer<typeof factSourceSchema>

export const factSchema = z.object({
  id: z.string().uuid(),
  entityKind: entityKindSchema,
  entityType: z.string(),
  entityId: z.string(),
  key: z.string(),
  /** Valid against the type's value schema for `key` when it was written. */
  value: z.unknown(),
  /** Normalised text for display and matching. */
  valueText: z.string(),
  source: factSourceSchema,
  confidence: z.number().min(0).max(1),
  state: factStateSchema,
  supersededById: z.string().uuid().nullable(),
  /** The other facts on the same entity and key that disagree with this one. */
  conflictsWith: z.array(z.string().uuid()),
  /** When it was true in the world — null when the source does not say. */
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  /** When we learned it (the source document's date). */
  observedAt: z.coerce.date(),
  confirmedBy: z.string().uuid().nullable(),
  confirmedAt: z.coerce.date().nullable(),
  /** Who is asked to settle it while it is unconfirmed or conflicting. */
  reviewerUserId: z.string().uuid().nullable(),
  visibility: factVisibilitySchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Fact = z.infer<typeof factSchema>

/** `GET /api/knowledge/entities/:type/:id` — the entity and every fact about it you may read. */
export const entityCardSchema = z.object({
  entity: z.object({
    kind: entityKindSchema,
    type: z.string(),
    /** The type's label ("Order"). */
    typeLabel: z.string(),
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    /** Staging only: where it was promoted to, or the entity it was merged into. */
    promotedTo: entityRefSchema.nullable(),
    mergedInto: z.string().uuid().nullable(),
  }),
  facts: z.array(factSchema),
})
export type EntityCard = z.infer<typeof entityCardSchema>

// ── Review ────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/knowledge/facts/:id/review`. `confirm` = "this is right" (accepted, confirmed by
 * me), `reject` = "not right", `prefer` = "use this one" (accepted; the conflicting sides become
 * superseded by it).
 */
export const FACT_REVIEW_ACTIONS = ['confirm', 'reject', 'prefer'] as const
export const factReviewRequestSchema = z.object({ action: z.enum(FACT_REVIEW_ACTIONS) })
export type FactReviewRequest = z.infer<typeof factReviewRequestSchema>

/**
 * A staging entity that might be an existing row: several candidates, or one just under the
 * match threshold. Settled by merge or promote, never automatically.
 */
export const possibleMatchSchema = z.object({
  kind: z.literal('possibleMatch'),
  entity: knowledgeEntitySchema,
  candidates: z.array(possibleMatchCandidateSchema).min(1),
  reviewerUserId: z.string().uuid().nullable(),
})
export type PossibleMatch = z.infer<typeof possibleMatchSchema>

/** A fact waiting for a person: unconfirmed, or conflicting with the facts it names. */
export const factReviewItemSchema = z.object({
  kind: z.literal('fact'),
  fact: factSchema,
  /** The other sides of a conflict, so the item can be settled in place. */
  conflicts: z.array(factSchema),
})
export type FactReviewItem = z.infer<typeof factReviewItemSchema>

export const knowledgeReviewItemSchema = z.discriminatedUnion('kind', [
  factReviewItemSchema,
  possibleMatchSchema,
])
export type KnowledgeReviewItem = z.infer<typeof knowledgeReviewItemSchema>

// ── Tool results ──────────────────────────────────────────────────────────────────────────────

/**
 * One fact as `lookup_facts` and `search_knowledge`'s `facts` block return it to a model: small,
 * cited, and labelled — `state` says whether it may be stated plainly, `preferred` which side of
 * a conflict an answer leads with (both are always cited).
 */
export const factHitSchema = z.object({
  factId: z.string().uuid(),
  entity: z.object({ kind: entityKindSchema, type: z.string(), id: z.string(), name: z.string() }),
  key: z.string(),
  value: z.unknown(),
  valueText: z.string(),
  state: factStateSchema,
  preferred: z.boolean(),
  conflictsWith: z.array(z.string().uuid()),
  sourceKind: sourceKindSchema,
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  quote: z.string(),
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  observedAt: z.coerce.date(),
})
export type FactHit = z.infer<typeof factHitSchema>
