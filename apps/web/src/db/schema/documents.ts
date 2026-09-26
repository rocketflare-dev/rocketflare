/**
 * `documents` — a piece of text a tenant indexed for retrieval (D18). `content` holds the text
 * that was chunked (pasted text, or the converted text of an upload — never returned by the API)
 * so the `document.index` job — and any future re-index after a model change — re-reads it from
 * the row, not from a queue message. An uploaded file keeps its original in R2 through `fileId`
 * (a `files` row, scope `documents`); `contentType` is the ORIGINAL media type and `content` is
 * null until the `document.convert` job has run. `status` moves `pending → indexed` (with
 * `chunkCount` and the `embeddingModel` that produced the vectors) or `→ failed` with a redacted
 * `error`. Chunks cascade from here; the file row is deleted by the document route.
 */
import type { DocumentStatus } from '@rocketflare/shared/ai/embeddings'
import { relations, sql } from 'drizzle-orm'
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { RESOURCE_VISIBILITY_VALUES, tenantRef, timestamps } from './_helpers'
import { files } from './files'
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
    /**
     * D34: the id this document has IN its source — a message id, a drive item id — so a sync that
     * sees the same item again updates this row instead of adding a second one. Null for anything a
     * person uploaded or pasted. Unique per `(tenant, source)`, which is why a plugin's `source` is
     * namespaced (`m365:mail`): two sources may reuse one another's ids freely.
     */
    externalId: text('external_id'),
    contentType: text('content_type').notNull().default('text/plain'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** The text `indexDocument` chunks — API-invisible; null for an upload not yet converted. */
    content: text('content'),
    /** The uploaded original (`files` row, scope `documents`); null for pasted text. */
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    chunkCount: integer('chunk_count').notNull().default(0),
    /** Which embeddings model produced this document's vectors (D18: warn before mixing). */
    embeddingModel: text('embedding_model'),
    status: text('status', { enum: DOCUMENT_STATUS_VALUES }).notNull().default('pending'),
    /**
     * Who may READ this document (D29). Defaults to `tenant`, so every existing row and every
     * ingest that says nothing keeps the pre-Groups behaviour. `groups` narrows it to
     * `document_groups` — an EMPTY grant list is legal and means owner-and-admins only.
     */
    visibility: text('visibility', { enum: RESOURCE_VISIBILITY_VALUES })
      .notNull()
      .default('tenant'),
    error: text('error'),
    ...timestamps(),
  },
  table => [
    index('documents_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    index('documents_tenant_owner_idx').on(table.tenantId, table.ownerUserId),
    uniqueIndex('documents_tenant_source_external_uq')
      .on(table.tenantId, table.source, table.externalId)
      .where(sql`${table.externalId} is not null`),
    tenantIsolation('documents'),
  ]
)

export const documentsRelations = relations(documents, ({ one }) => ({
  tenant: one(tenants, { fields: [documents.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [documents.ownerUserId], references: [users.id] }),
  file: one(files, { fields: [documents.fileId], references: [files.id] }),
}))

export type DocumentRow = typeof documents.$inferSelect
export type NewDocumentRow = typeof documents.$inferInsert
