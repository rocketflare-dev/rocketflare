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
 * (`docs/CONCEPTS.md` §9, "Knowledge facts").
 */
import { z } from 'zod'
import { paginatedResponse, paginationQuerySchema } from '../pagination'
import { KNOWLEDGE_TOOLS } from './embeddings'

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
  /**
   * Keys whose value NAMES an entity of another registered type — `{ account_manager: 'person' }`.
   * The value is still the name as the document writes it (the key's schema must be a string),
   * but extraction resolves it to an entity of that type exactly as it resolves the fact's own
   * entity (aliases, the domain resolver, the decision model), and two facts compare by the
   * entity they name: "Marcus" and "Marcus Bell" agree once both resolve to one person, and two
   * people with one first name do not.
   */
  refs?: Partial<Record<keyof F['shape'] & string, string>>
}

/** The entity type a key's value names (`EntityTypeDeclaration.refs`), or undefined. */
export function factRefType(
  decl: Pick<EntityTypeDeclaration, 'refs'>,
  key: string
): string | undefined {
  const refs = decl.refs as Record<string, string | undefined> | undefined
  return refs && Object.hasOwn(refs, key) ? refs[key] : undefined
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
    refs: z.record(z.string(), entityTypeNameSchema).optional(),
  })
  .superRefine((decl, ctx) => {
    const keys = Object.keys(decl.facts.shape)
    if (keys.length === 0) ctx.addIssue({ code: 'custom', message: 'facts declares no key' })
    for (const [key, target] of Object.entries(decl.refs ?? {})) {
      const schema = Object.hasOwn(decl.facts.shape, key) ? decl.facts.shape[key] : undefined
      if (!schema) {
        ctx.addIssue({
          code: 'custom',
          path: ['refs', key],
          message: 'refs names an undeclared key',
        })
        continue
      }
      let type: unknown
      try {
        type = (z.toJSONSchema(schema as z.ZodType) as { type?: unknown }).type
      } catch {
        type = undefined
      }
      if (type !== 'string') {
        ctx.addIssue({
          code: 'custom',
          path: ['refs', key],
          message: `a key that names a ${target} must be a string (the name as written)`,
        })
      }
    }
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

/** What the preference rule reads about a fact: when its source was written, and how trusted. */
export interface PreferenceInput {
  observedAt: Date
  sourceKind: SourceKind
}

/**
 * Of two facts that disagree, does an answer lead with `a` rather than `b`? The NEWER one wins
 * when its source is at least as trusted as the older one's; otherwise the older one does
 * (decision 3 — a synced email does not overturn a signed contract by being later). Two facts
 * observed at the same moment: the more trusted, then `a`.
 *
 * **Preference is derived, never stored.** It is a function of the two facts' `observedAt` and
 * `sourceKind`, both immutable, so a stored flag could only drift from it. It orders an answer;
 * both sides are always cited, and a person's "use this one" (`prefer`) supersedes the others
 * instead of flipping a flag.
 */
export function isPreferredOver(a: PreferenceInput, b: PreferenceInput): boolean {
  const ta = a.observedAt.getTime()
  const tb = b.observedAt.getTime()
  if (ta === tb) return trustRank(a.sourceKind) >= trustRank(b.sourceKind)
  const [older, newer] = ta < tb ? [a, b] : [b, a]
  const newerWins = trustRank(newer.sourceKind) >= trustRank(older.sourceKind)
  return (newerWins ? newer : older) === a
}

/**
 * The fact an answer leads with among several that disagree: walk them oldest first and move to
 * each newer one `isPreferredOver` the current choice. Undefined for an empty list.
 */
export function preferredFact<T extends PreferenceInput>(facts: readonly T[]): T | undefined {
  const ordered = [...facts].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
  let chosen: T | undefined
  for (const fact of ordered) {
    if (!chosen || isPreferredOver(fact, chosen)) chosen = fact
  }
  return chosen
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
  /**
   * For a key that names an entity (`EntityTypeDeclaration.refs`): the entity the value resolved
   * to — "Marcus" in the text, the person Marcus Bell here. Link it with `entityPath`.
   */
  valueEntity: z
    .object({ kind: entityKindSchema, type: z.string(), id: z.string() })
    .nullable()
    .optional(),
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

/** `knowledge_facts.value_ref` (`<kind>:<type>:<id>`) as `Fact.valueEntity`, or null. */
export function parseValueRef(ref: string | null | undefined): Fact['valueEntity'] {
  if (!ref) return null
  const [kind, type, ...id] = ref.split(':')
  const parsed = entityKindSchema.safeParse(kind)
  if (!parsed.success || !type || id.length === 0) return null
  return { kind: parsed.data, type, id: id.join(':') }
}

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
    /**
     * Staging only: `POST /entities/:id/promote` can succeed — the type is registered with a
     * table or a resolver to find the row in, and the entity is not merged or promoted yet.
     */
    promotable: z.boolean(),
    /** Staging only: who is asked to settle it (merge, promote, keep separate); else null. */
    reviewerUserId: z.string().uuid().nullable(),
  }),
  facts: z.array(factSchema),
})
export type EntityCard = z.infer<typeof entityCardSchema>

/** The ONE place the entity page's route is written: `/knowledge/entities/:type/:id`. */
export function entityPath(type: string, id: string): string {
  return `/knowledge/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
}

// ── Review ────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/knowledge/facts/:id/review`.
 *
 * - `confirm` = "this is right": `accepted`, `confirmedBy`/`confirmedAt` = me; the source's trust
 *   is unchanged. Not for a fact in conflict (409 `fact_conflicting`) — pick a side with `prefer`.
 * - `reject` = "not right": `rejected`, unlinked from its conflicts; a fact it was the only
 *   disagreement for goes back to `accepted` / `unconfirmed`.
 * - `prefer` = "use this one": `accepted` and confirmed by me, and every fact it conflicted with
 *   becomes `rejected` — NOT `superseded`, which means "true for an earlier window, replaced by a
 *   later one": an `asOf` lookup would answer with a superseded fact and re-extraction would
 *   restore one, whereas a person choosing between two values for the SAME time has said the
 *   other was never right.
 *
 * Each acts only on what the reviewer can see: a conflicting fact from a document hidden from
 * them is neither shown nor touched, so the fact keeps its link to it (and stays `conflicting`
 * for the admins who can see both).
 */
export const FACT_REVIEW_ACTIONS = ['confirm', 'reject', 'prefer'] as const
export const factReviewActionSchema = z.enum(FACT_REVIEW_ACTIONS)
export type FactReviewAction = z.infer<typeof factReviewActionSchema>
export const factReviewRequestSchema = z.object({ action: factReviewActionSchema })
export type FactReviewRequest = z.infer<typeof factReviewRequestSchema>

/** The reviewed fact as it now stands, and every other fact the action changed. */
export const factReviewResponseSchema = z.object({
  fact: factSchema,
  affected: z.array(factSchema),
})
export type FactReviewResponse = z.infer<typeof factReviewResponseSchema>

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

/** Which entity an item is about, named for display — what `entityPath` links to. */
export const reviewEntitySchema = z.object({
  kind: entityKindSchema,
  type: z.string(),
  id: z.string(),
  name: z.string(),
})
export type ReviewEntity = z.infer<typeof reviewEntitySchema>

/** A fact waiting for a person: unconfirmed, or conflicting with the facts it names. */
export const factReviewItemSchema = z.object({
  kind: z.literal('fact'),
  fact: factSchema,
  /** The entity the fact is about (its staging name, or a domain row's label). */
  entity: reviewEntitySchema,
  /** The other sides of a conflict, so the item can be settled in place. */
  conflicts: z.array(factSchema),
})
export type FactReviewItem = z.infer<typeof factReviewItemSchema>

export const knowledgeReviewItemSchema = z.discriminatedUnion('kind', [
  factReviewItemSchema,
  possibleMatchSchema,
])
export type KnowledgeReviewItem = z.infer<typeof knowledgeReviewItemSchema>

export const KNOWLEDGE_REVIEW_KINDS = ['fact', 'possibleMatch'] as const

/**
 * `GET /api/knowledge/review` — open items, newest first: mine, or everyone's for an admin
 * (`mine=true` narrows an admin to their own). `entityType` / `entityId` narrow to one type or
 * one entity (an entity card's "open items").
 */
export const knowledgeReviewQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(KNOWLEDGE_REVIEW_KINDS).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  mine: z
    .enum(['true', 'false'])
    .transform(v => v === 'true')
    .optional(),
})
export type KnowledgeReviewQuery = z.infer<typeof knowledgeReviewQuerySchema>

export const knowledgeReviewListSchema = paginatedResponse(knowledgeReviewItemSchema)
export type KnowledgeReviewList = z.infer<typeof knowledgeReviewListSchema>

// ── Entity actions ────────────────────────────────────────────────────────────────────────────

/** `GET /api/knowledge/entities/:type/:id` — a staging entity's uuid, or a domain row's id. */
export const entityCardParamSchema = z.object({
  type: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(200),
})

/** Where a merge sends a staging entity: another staging entity, or a domain row (= promote). */
export const entityTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staging'), id: z.string().uuid() }),
  z.object({ kind: z.literal('domain'), id: z.string().trim().min(1).max(200) }),
])
export type EntityTarget = z.infer<typeof entityTargetSchema>

/**
 * `POST /api/knowledge/entities/:id/merge` — "these are the same": the staging entity's facts
 * move to `into`, its names become aliases of a staging target, and it is marked `mergedInto`.
 * A domain `into` is a promote.
 */
export const mergeEntityRequestSchema = z.object({ into: entityTargetSchema })
export type MergeEntityRequest = z.infer<typeof mergeEntityRequestSchema>

/**
 * `POST /api/knowledge/entities/:id/promote` — "this is that row of ours": a row of the entity's
 * own (registered) type, found by the type's table or resolver in this tenant. Records
 * `promotedTo` and moves the facts onto the row; NEVER writes a domain column.
 */
export const promoteEntityRequestSchema = z.object({ id: z.string().trim().min(1).max(200) })
export type PromoteEntityRequest = z.infer<typeof promoteEntityRequestSchema>

/**
 * `GET /api/knowledge/entities/:id/promote-candidates?q=` — the Promote picker: rows of the staging
 * entity's registered type matching `q` (default: the entity's own name), best first.
 */
export const promoteCandidatesQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
})
export type PromoteCandidatesQuery = z.infer<typeof promoteCandidatesQuerySchema>

/** At most this many rows answer one picker query. */
export const PROMOTE_CANDIDATES_MAX = 10

export const promoteCandidatesResponseSchema = z.object({
  /** What was searched: `q`, or the entity's name when `q` was empty. */
  query: z.string(),
  candidates: z.array(entityCandidateSchema).max(PROMOTE_CANDIDATES_MAX),
})
export type PromoteCandidatesResponse = z.infer<typeof promoteCandidatesResponseSchema>

/** What merge, promote and keep-separate answer: the staging entity as it now stands. */
export const entityActionResponseSchema = z.object({
  entity: knowledgeEntitySchema,
  /** Where its facts went (merge / promote), else null. */
  into: z.object({ kind: entityKindSchema, type: z.string(), id: z.string() }).nullable(),
  movedFacts: z.number().int().nonnegative(),
  /** Keys whose states were decided again because both entities held facts for them. */
  recomputedKeys: z.array(z.string()),
})
export type EntityActionResponse = z.infer<typeof entityActionResponseSchema>

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
  /** A key that names an entity (`refs`): who or what the value resolved to, by its own name. */
  names: z
    .object({ kind: entityKindSchema, type: z.string(), id: z.string(), name: z.string() })
    .optional(),
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

/** Facts about one entity, as `lookup_facts` and `search_knowledge`'s `facts` block group them. */
export const factHitGroupSchema = z.object({
  entity: z.object({ kind: entityKindSchema, type: z.string(), id: z.string(), name: z.string() }),
  facts: z.array(factHitSchema),
})
export type FactHitGroup = z.infer<typeof factHitGroupSchema>

/**
 * `GET /api/knowledge/mentioned?q=` — the Search page's facts block: the facts about the entities
 * a query names (`search_knowledge`'s `facts` block, for a person), read through the documents'
 * visibility like every fact read. `entities` is empty when the query names no known entity.
 */
export const mentionedFactsQuerySchema = z.object({ q: z.string().trim().min(1).max(2000) })
export type MentionedFactsQuery = z.infer<typeof mentionedFactsQuerySchema>

export const mentionedFactsResponseSchema = z.object({ entities: z.array(factHitGroupSchema) })
export type MentionedFactsResponse = z.infer<typeof mentionedFactsResponseSchema>

/** What `lookup_facts` answers (JSON-encoded for the model). */
export const lookupFactsResultSchema = z.object({
  entities: z.array(factHitGroupSchema),
  /** How to state what came back — always present with results. */
  note: z.string().optional(),
  /** What to do next — present when nothing matched or the answer was cut. */
  hint: z.string().optional(),
  /** Facts that matched but did not fit the answer. */
  omitted: z.number().int().positive().optional(),
})
export type LookupFactsResult = z.infer<typeof lookupFactsResultSchema>

// ── Entity cards in a chat answer ─────────────────────────────────────────────────────────────

/** Facts a chat card lists per entity at most; the entity page has the rest. */
export const CHAT_ENTITY_CARD_MAX_FACTS = 6

/**
 * One entity a chat turn's knowledge tools touched (`lookup_facts`, or `search_knowledge`'s
 * `facts` block), as the compact card under the answer: the entity, the facts the tool returned
 * with their states, and a link to its page. Built from the tool's JSON by a pure mapper, never a
 * query — so it can show only what the model was shown, which the reader could already see.
 */
export const chatEntityCardSchema = z.object({
  entity: reviewEntitySchema,
  /** `entityPath(type, id)`. */
  href: z.string(),
  facts: z
    .array(
      z.object({
        factId: z.string().uuid(),
        key: z.string(),
        valueText: z.string(),
        state: factStateSchema,
        documentId: z.string().uuid(),
        documentTitle: z.string(),
      })
    )
    .max(CHAT_ENTITY_CARD_MAX_FACTS),
  /** Facts the tool returned beyond the card's limit. */
  moreFacts: z.number().int().nonnegative(),
})
export type ChatEntityCard = z.infer<typeof chatEntityCardSchema>

/** Read loosely: only what a card needs, so a retune of the tool's JSON cannot break the UI. */
const factGroupLoose = z.object({
  entity: z.object({ kind: entityKindSchema, type: z.string(), id: z.string(), name: z.string() }),
  facts: z.array(
    z.object({
      factId: z.string().uuid(),
      key: z.string(),
      valueText: z.string(),
      state: factStateSchema,
      documentId: z.string().uuid(),
      documentTitle: z.string(),
    })
  ),
})
const lookupLoose = z.object({ entities: z.array(factGroupLoose) })
const searchLoose = z.object({ facts: z.array(factGroupLoose) })

/** The entity cards one tool call's answer implies — `[]` for any other tool or shape. */
export function entityCardsFromToolResult(toolName: string, result: unknown): ChatEntityCard[] {
  let parsed: unknown = result
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result)
    } catch {
      return []
    }
  }
  let groups: z.infer<typeof factGroupLoose>[] = []
  if (toolName === KNOWLEDGE_TOOLS.facts) {
    const r = lookupLoose.safeParse(parsed)
    if (r.success) groups = r.data.entities
  } else if (toolName === KNOWLEDGE_TOOLS.search) {
    const r = searchLoose.safeParse(parsed)
    if (r.success) groups = r.data.facts
  }
  return entityCardsFromFactGroups(groups)
}

/** One card per entity with facts, capped at `CHAT_ENTITY_CARD_MAX_FACTS` (the rest: `moreFacts`). */
export function entityCardsFromFactGroups(
  groups: readonly z.infer<typeof factGroupLoose>[]
): ChatEntityCard[] {
  return groups
    .filter(g => g.facts.length > 0)
    .map(g => ({
      entity: g.entity,
      href: entityPath(g.entity.type, g.entity.id),
      facts: g.facts.slice(0, CHAT_ENTITY_CARD_MAX_FACTS),
      moreFacts: Math.max(0, g.facts.length - CHAT_ENTITY_CARD_MAX_FACTS),
    }))
}

const cardKey = (c: ChatEntityCard) => `${c.entity.kind}:${c.entity.type}:${c.entity.id}`

/**
 * Every entity card a persisted assistant message's `toolCalls` imply, one per entity, in call
 * order — the first call that named an entity supplies its card (the stream does the same).
 */
export function entityCardsFromToolCalls(
  calls: readonly { name: string; result?: string }[] | null | undefined
): ChatEntityCard[] {
  const out: ChatEntityCard[] = []
  const seen = new Set<string>()
  for (const call of calls ?? []) {
    for (const card of entityCardsFromToolResult(call.name, call.result)) {
      if (seen.has(cardKey(card))) continue
      seen.add(cardKey(card))
      out.push(card)
    }
  }
  return out
}

/** Stable identity of a card's entity, for de-duplicating cards across tool calls. */
export const chatEntityCardKey = cardKey

// ── Browsing facts (the document's facts, the Knowledge page's Facts view) ───────────────────

/** An entity as a browse view names it: the ref, its display name, and its type's label. */
export const browseEntitySchema = reviewEntitySchema.extend({ typeLabel: z.string() })
export type BrowseEntity = z.infer<typeof browseEntitySchema>

/** The facts one document gave about one entity. */
export const documentFactGroupSchema = z.object({
  entity: browseEntitySchema,
  /** Every state, as on the entity page — `rejected` and `superseded` included, labelled. */
  facts: z.array(factSchema),
})
export type DocumentFactGroup = z.infer<typeof documentFactGroupSchema>

/**
 * `GET /api/knowledge/documents/:id/facts` — the facts read from one document the reader may see
 * (404 otherwise, the same as an absent one), grouped by entity. `entityTypesRegistered` = 0 means
 * extraction has nothing to look for, which is why a document can have none.
 */
export const documentFactsResponseSchema = z.object({
  documentId: z.string().uuid(),
  entityTypesRegistered: z.number().int().nonnegative(),
  groups: z.array(documentFactGroupSchema),
})
export type DocumentFactsResponse = z.infer<typeof documentFactsResponseSchema>

/** A comma-separated query value (`a,b`) → its de-duplicated, non-blank parts. */
const splitCsv = (v: string) => [
  ...new Set(
    v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  ),
]
const csvString = z.string().trim().max(2000).transform(splitCsv)

/**
 * `GET /api/knowledge/entities` — every entity the reader may see a CURRENT fact about
 * (`accepted`, `unconfirmed`, `conflicting`), with counts over those visible facts only.
 * `type` / `sourceKind` (comma-separated) narrow which facts count; `needsLook=true` keeps only
 * entities with a fact open in the reader's view; `q` matches a staging entity's name or aliases
 * (a domain row is matched through the staging entities promoted to it).
 */
export const knowledgeEntityListQuerySchema = paginationQuerySchema.extend({
  type: csvString.pipe(z.array(z.string().min(1).max(120)).max(50)).optional(),
  sourceKind: csvString.pipe(z.array(sourceKindSchema).max(50)).optional(),
  needsLook: z
    .enum(['true', 'false'])
    .transform(v => v === 'true')
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
})
export type KnowledgeEntityListQuery = z.infer<typeof knowledgeEntityListQuerySchema>

export const knowledgeEntitySummarySchema = z.object({
  entity: browseEntitySchema,
  /** Current facts the reader may see (under the filters). */
  facts: z.number().int().nonnegative(),
  /** Of those, open in the reader's view — unconfirmed, or conflicting with a fact they can see. */
  needsLook: z.number().int().nonnegative(),
  /** The newest `observedAt` among them. */
  lastObservedAt: z.coerce.date(),
})
export type KnowledgeEntitySummary = z.infer<typeof knowledgeEntitySummarySchema>

/** How a fact's source kind reads in a filter. */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  person: 'Added by a person',
  upload: 'Uploaded documents',
  agent: 'Agent output',
  integration: 'Integrations',
}

/** One filter value and how many entities carry it (over every visible current fact, unfiltered). */
export const knowledgeFacetValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
})
export type KnowledgeFacetValue = z.infer<typeof knowledgeFacetValueSchema>

export const knowledgeEntityListSchema = paginatedResponse(knowledgeEntitySummarySchema).extend({
  facets: z.object({
    types: z.array(knowledgeFacetValueSchema),
    sourceKinds: z.array(knowledgeFacetValueSchema),
  }),
})
export type KnowledgeEntityList = z.infer<typeof knowledgeEntityListSchema>
