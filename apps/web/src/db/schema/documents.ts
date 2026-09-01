/**
 * `documents` — a piece of text a tenant indexed for retrieval (D18). `content` holds the raw text
 * (never returned by the API) so the `document.index` job — and any future re-index after a model
 * change — re-reads it from the row, not from a queue message. `status` moves `pending → indexed`
 * (with `chunkCount` and the `embeddingModel` that produced the vectors) or `→ failed` with a
 * redacted `error`. Chunks cascade from here.
 */
import type { DocumentStatus } from '@gmgo/shared/ai/embeddings'
import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const DOCUMENT_STATUS_VALUES = [
  'pending',
  'indexed',
  'failed',
] as const satisfies readonly DocumentStatus[]

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Origin marker: `upload`, `agent:summarize-text`, a URL … */
    source: text('source'),
    contentType: text('content_type').notNull().default('text/plain'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** The raw text — API-invisible; what `indexDocument` chunks. */
    content: text('content'),
    chunkCount: integer('chunk_count').notNull().default(0),
    /** Which embeddings model produced this document's vectors (D18: warn before mixing). */
    embeddingModel: text('embedding_model'),
    status: text('status', { enum: DOCUMENT_STATUS_VALUES }).notNull().default('pending'),
    error: text('error'),
    ...timestamps(),
  },
  table => [
    index('documents_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    index('documents_tenant_owner_idx').on(table.tenantId, table.ownerUserId),
    tenantIsolation('documents'),
  ]
)

export const documentsRelations = relations(documents, ({ one }) => ({
  tenant: one(tenants, { fields: [documents.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [documents.ownerUserId], references: [users.id] }),
}))

export type DocumentRow = typeof documents.$inferSelect
export type NewDocumentRow = typeof documents.$inferInsert
