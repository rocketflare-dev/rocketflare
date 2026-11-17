/**
 * `knowledge_entities` — the STAGING entities of knowledge facts (D43): something documents talk
 * about that the domain has no row for yet ("Brightside Bakery", mentioned in a contract before
 * anyone created the customer). Facts attach here (`knowledge_facts.entity_kind = 'staging'`)
 * until a person or an approved agent action promotes the entity to a domain row
 * (`promoted_type` + `promoted_id`) or merges it into another staging entity (`merged_into`).
 *
 * `type` is a registered entity type (`customer`, `example-feature.note`) — a type with no domain
 * table lives ONLY here. Resolution reads `name` and `aliases` through the trigram index (the
 * `pg_trgm` extension, created by `scripts/migrate.ts` and by migration 0028) and `embedding`
 * (of name + aliases, `embedding_model` recorded like `chunks`), so a mention finds an entity it
 * spells differently. `(tenant_id, type, lower(name))` is the exact-name lookup; it is not unique,
 * because two entities may share a name until somebody merges them.
 *
 * `possible_matches` is the open "is this the same as …?" review item: the candidates resolution
 * found but would not link to (several, or one just under the threshold). Non-null and non-empty
 * means open; settling it (merge, promote, or "different") clears it. `reviewer_user_id` is who is
 * asked. Deleting the last fact about an entity leaves the entity in place — no trigger.
 */

import { EMBEDDING_DIM } from '@rocketflare/shared/ai/config'
import type { PossibleMatchCandidate } from '@rocketflare/shared/ai/knowledge-facts'
import { sql } from 'drizzle-orm'
import { type AnyPgColumn, index, jsonb, pgTable, text, uuid, vector } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const knowledgeEntities = pgTable(
  'knowledge_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** A registered entity type: `name` (the app's) or `<plugin id>.name`. */
    type: text('type').notNull(),
    name: text('name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    /** Set together once promoted: the registered type and the domain row's id (as text). */
    promotedType: text('promoted_type'),
    promotedId: text('promoted_id'),
    /** The staging entity this one was merged into; its facts moved there. */
    mergedInto: uuid('merged_into').references((): AnyPgColumn => knowledgeEntities.id, {
      onDelete: 'set null',
    }),
    /** Of `name` + `aliases`, for resolution; null until embedded. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    /** The open possible-match review item; null when there is none. */
    possibleMatches: jsonb('possible_matches').$type<PossibleMatchCandidate[]>(),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  table => [
    index('knowledge_entities_tenant_type_name_idx').on(
      table.tenantId,
      table.type,
      sql`lower(${table.name})`
    ),
    index('knowledge_entities_name_trgm_idx').using('gin', table.name.op('gin_trgm_ops')),
    index('knowledge_entities_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    index('knowledge_entities_open_match_idx')
      .on(table.tenantId, table.reviewerUserId)
      .where(sql`${table.possibleMatches} IS NOT NULL`),
    tenantIsolation('knowledge_entities'),
  ]
)

export type KnowledgeEntityRow = typeof knowledgeEntities.$inferSelect
export type NewKnowledgeEntityRow = typeof knowledgeEntities.$inferInsert
