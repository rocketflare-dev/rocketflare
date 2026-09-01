/**
 * `chunks` — the retrievable pieces of a document with their embedding (D17, D18): pgvector on
 * Postgres, NOT Vectorize, so vectors stay inside the tenant's rows and under RLS. The column is
 * `vector(EMBEDDING_DIM)` (1024, matching `@cf/baai/bge-m3`); changing the dimension is a NEW
 * table, not an `ALTER`. Dense retrieval is cosine (`<=>`) over the HNSW index; the lexical half
 * is `to_tsvector('english', text)` computed at query time (a generated tsvector + GIN index is the
 * documented scaling path). Every query carries the tenant predicate first.
 */
import { EMBEDDING_DIM } from '@gmgo/shared/ai/config'
import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { documents } from './documents'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tenantId: tenantRef(tenants),
    /** Position within the document, from 0. */
    seq: integer('seq').notNull(),
    text: text('text').notNull(),
    /** Character-based estimate (`estimateTokens`), not a tokenizer count. */
    tokenCount: integer('token_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    ...timestamps(),
  },
  table => [
    uniqueIndex('chunks_document_seq_idx').on(table.documentId, table.seq),
    index('chunks_tenant_document_idx').on(table.tenantId, table.documentId),
    // Cosine ANN index for dense retrieval (pgvector HNSW).
    index('chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    tenantIsolation('chunks'),
  ]
)

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, { fields: [chunks.documentId], references: [documents.id] }),
  tenant: one(tenants, { fields: [chunks.tenantId], references: [tenants.id] }),
}))

export type ChunkRow = typeof chunks.$inferSelect
export type NewChunkRow = typeof chunks.$inferInsert
