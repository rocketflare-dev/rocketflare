/**
 * `knowledge_facts` — one typed fact read from one place in one document (D43): "order 1042's
 * delivery date is 3 March", with the quote, the trust of its source, its state and when it was
 * true. Several sources saying the same thing are several rows.
 *
 * - **Identity.** `entity_kind` `domain` (an app/plugin row of a registered type — `entity_id` is
 *   that row's id as text, so any key type fits) or `staging` (a `knowledge_entities` id). No
 *   foreign key on the entity: it points at one of many tables (no polymorphic FKs).
 * - **Source.** `document_id` CASCADES — deleting a document removes the facts read from it.
 *   `chunk_id` is SET NULL: re-indexing replaces every chunk, and a fact must survive that (the
 *   span and the quote still locate it in `documents.content`).
 * - **Access.** A fact is read through its document: `visibility` mirrors the document's
 *   (`tenant | groups`) and the document's grants apply through `document_id` — there is no grants
 *   table for facts. `private` is reserved for a later memory plugin and never written yet.
 * - **State.** `FACT_STATES`; `conflicts_with` names the other rows on the same entity and key
 *   that disagree. The open review items (`OPEN_REVIEW_FACT_STATES`) have a partial index on
 *   `(tenant_id, reviewer_user_id)`, its predicate rendered from that shared list.
 */
import {
  ENTITY_KINDS,
  FACT_STATES,
  FACT_VISIBILITY,
  OPEN_REVIEW_FACT_STATES,
  SOURCE_TRUST,
} from '@rocketflare/shared/ai/knowledge-facts'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { chunks } from './chunks'
import { documents } from './documents'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

const OPEN_STATE_LITERALS = OPEN_REVIEW_FACT_STATES.map(state => `'${state}'`).join(', ')

export const knowledgeFacts = pgTable(
  'knowledge_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    // identity
    entityKind: text('entity_kind', { enum: ENTITY_KINDS }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    // content
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    /** Normalised, for display and matching. */
    valueText: text('value_text').notNull(),
    // source
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    quote: text('quote').notNull(),
    // trust
    sourceKind: text('source_kind', { enum: SOURCE_TRUST }).notNull(),
    confidence: real('confidence').notNull(),
    // state
    state: text('state', { enum: FACT_STATES }).notNull(),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => knowledgeFacts.id, {
      onDelete: 'set null',
    }),
    conflictsWith: uuid('conflicts_with').array().notNull().default(sql`'{}'::uuid[]`),
    // time
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    // access
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
    visibility: text('visibility', { enum: FACT_VISIBILITY }).notNull().default('tenant'),
    ...timestamps(),
  },
  table => [
    index('knowledge_facts_tenant_entity_idx').on(
      table.tenantId,
      table.entityKind,
      table.entityType,
      table.entityId
    ),
    index('knowledge_facts_tenant_document_idx').on(table.tenantId, table.documentId),
    index('knowledge_facts_open_review_idx')
      .on(table.tenantId, table.reviewerUserId)
      .where(sql`${table.state} IN (${sql.raw(OPEN_STATE_LITERALS)})`),
    check('knowledge_facts_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
    tenantIsolation('knowledge_facts'),
  ]
)

export type KnowledgeFactRow = typeof knowledgeFacts.$inferSelect
export type NewKnowledgeFactRow = typeof knowledgeFacts.$inferInsert
