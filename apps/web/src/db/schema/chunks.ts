/**
 * `chunks` — the retrievable pieces of a document with their embedding: pgvector on
 * Postgres, NOT Vectorize, so vectors stay inside the tenant's rows and under RLS. The column is
 * `vector(EMBEDDING_DIM)` (1024, matching `@cf/baai/bge-m3`); changing the dimension is a NEW
 * table, not an `ALTER`. Dense retrieval is cosine (`<=>`) over the HNSW index, limited to the
 * chunks `embedding_model` says were embedded by the query vector's model. The lexical half reads
 * `search_vector`, a GENERATED tsvector over heading path + table header + text with a GIN index;
 * its `'english'` is `SEARCH_TEXT_CONFIG` (`services/ai/retrieval.ts`), pinned by
 * `tests/config/search-text-config.test.ts`. `text` is an exact slice of `documents.content` at
 * `[char_start, char_end)` (null only on rows written before 0.37.0). Every query carries the
 * tenant predicate first — `tenant_id = $t`, or `tenant_id is null` for a PLATFORM document's
 * chunks (read by every tenant, `platformReadable`).
 */
import { EMBEDDING_DIM } from '@rocketflare/shared/ai/config'
import { relations, sql } from 'drizzle-orm'
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { platformTenantRef, timestamps } from './_helpers'
import { documents } from './documents'
import { platformReadable, tenantIsolation } from './rls'
import { tenants } from './tenants'

/** Postgres `tsvector` — written only by the generated column, never by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** The document's tenant, copied; NULL exactly when the document is a platform one. */
    tenantId: platformTenantRef(tenants),
    /** Position within the document, from 0. */
    seq: integer('seq').notNull(),
    text: text('text').notNull(),
    /** Character-based estimate (`estimateTokens`), not a tokenizer count. */
    tokenCount: integer('token_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    /** The embeddings model that produced `embedding` — the dense leg's filter. */
    embeddingModel: text('embedding_model'),
    /** Enclosing markdown headings joined with ` › ` (`HEADING_PATH_SEPARATOR`); null when none. */
    headingPath: text('heading_path'),
    /** A table's header + delimiter rows, when this chunk holds its rows but not its header. */
    tableHeader: text('table_header'),
    /** Page of the source document; null — `toMarkdown` emits no page markers. */
    page: integer('page'),
    /** `text` is `documents.content.slice(charStart, charEnd)` (JS UTF-16 offsets). */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    /** The lexical index: heading path + table header + text, in `SEARCH_TEXT_CONFIG`. */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(table_header, '') || ' ' || text)`
    ),
    ...timestamps(),
  },
  table => [
    uniqueIndex('chunks_document_seq_idx').on(table.documentId, table.seq),
    index('chunks_tenant_document_idx').on(table.tenantId, table.documentId),
    // Cosine ANN index for dense retrieval (pgvector HNSW).
    index('chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('chunks_search_vector_idx').using('gin', table.searchVector),
    tenantIsolation('chunks'),
    platformReadable('chunks'),
  ]
)

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, { fields: [chunks.documentId], references: [documents.id] }),
  tenant: one(tenants, { fields: [chunks.tenantId], references: [tenants.id] }),
}))

export type ChunkRow = typeof chunks.$inferSelect
export type NewChunkRow = typeof chunks.$inferInsert
