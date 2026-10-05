/**
 * `memories` — atomic facts learned from a person's own conversations (D36), recalled across
 * threads by the `recall_memory` tool. The shape is Hindsight's `memory_units`, ported to the
 * kit's tenancy:
 *
 * - **Two clocks.** `mentionedAt` is when it was said (always known); `occurredStart` /
 *   `occurredEnd` is the time it is ABOUT, resolved to absolute instants at extraction ("last
 *   March" said in October becomes March of that year), null when the fact is not anchored in
 *   time. Temporal recall filters on the occurred range and falls back to `mentionedAt`.
 * - **An audience, not just an owner.** `visibility` is `private` (owner only — and never the D29
 *   admin bypass), `groups` (`memory_groups` grants) or `tenant`. Phase 1 writes `private` only;
 *   the other two let knowledge derived from documents inherit its source's audience later with
 *   no migration. `ownerUserId` is null for such knowledge-owned rows.
 * - **Provenance.** `sourceConversationId` cascades: deleting a conversation deletes what was
 *   learned from it. `sourceMessageIds` names the user turns, for the review page.
 * - **Superseded, not deleted.** `invalidatedAt` + `supersededById` (no FK — the replacement may
 *   itself be forgotten without rewriting history) keep "where did I live before?" answerable.
 * - **Lexical search is a stored column.** `searchVector` is GENERATED from the text plus
 *   `textSignals` (the entity names, space-joined — Hindsight's trick for making entities
 *   keyword-searchable without polluting the fact) and GIN-indexed; `chunks` still computes its
 *   tsvector at query time (`docs/CONCEPTS.md` §9 known gaps).
 */

import { EMBEDDING_DIM } from '@rocketflare/shared/ai/config'
import type { MemoryKind, MemoryVisibility } from '@rocketflare/shared/ai/memory'
import { MEMORY_KINDS, MEMORY_VISIBILITIES } from '@rocketflare/shared/ai/memory'
import { relations, type SQL, sql } from 'drizzle-orm'
import { customType, index, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { conversations } from './conversations'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Postgres `tsvector` — only ever GENERATED here, never written by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** The person this memory belongs to; null for knowledge-owned rows (none in phase 1). */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    visibility: text('visibility', { enum: MEMORY_VISIBILITIES })
      .$type<MemoryVisibility>()
      .notNull()
      .default('private'),
    kind: text('kind', { enum: MEMORY_KINDS }).$type<MemoryKind>().notNull().default('fact'),
    text: text('text').notNull(),
    occurredStart: timestamp('occurred_start', { withTimezone: true }),
    occurredEnd: timestamp('occurred_end', { withTimezone: true }),
    mentionedAt: timestamp('mentioned_at', { withTimezone: true }).notNull().defaultNow(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    embeddingModel: text('embedding_model'),
    /** Entity names, space-joined, folded into `searchVector`. */
    textSignals: text('text_signals').notNull().default(''),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english'::regconfig, coalesce(${memories.text}, '') || ' ' || coalesce(${memories.textSignals}, ''))`
    ),
    sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    sourceMessageIds: uuid('source_message_ids').array().notNull().default(sql`'{}'::uuid[]`),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    supersededById: uuid('superseded_by_id'),
    ...timestamps(),
  },
  table => [
    index('memories_tenant_owner_mentioned_idx').on(
      table.tenantId,
      table.ownerUserId,
      table.mentionedAt.desc()
    ),
    index('memories_tenant_owner_occurred_idx').on(
      table.tenantId,
      table.ownerUserId,
      table.occurredStart
    ),
    index('memories_tenant_conversation_idx').on(table.tenantId, table.sourceConversationId),
    index('memories_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('memories_search_idx').using('gin', table.searchVector),
    tenantIsolation('memories'),
  ]
)

export const memoriesRelations = relations(memories, ({ one }) => ({
  tenant: one(tenants, { fields: [memories.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [memories.ownerUserId], references: [users.id] }),
  conversation: one(conversations, {
    fields: [memories.sourceConversationId],
    references: [conversations.id],
  }),
}))

export type MemoryRow = typeof memories.$inferSelect
export type NewMemoryRow = typeof memories.$inferInsert
