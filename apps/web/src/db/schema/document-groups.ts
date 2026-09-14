/**
 * `document_groups` (D29) — which groups a `visibility: 'groups'` document is shared with.
 *
 * One junction table per resource, with a real FK and cascade, rather than one polymorphic
 * `(content_type, content_id)` table: a polymorphic id cannot be a foreign key, so deleting the
 * resource leaves rows behind that a later id could collide with.
 *
 * These rows are grants, never the visibility DECISION — that is `documents.visibility`. A
 * document with `visibility: 'groups'` and zero rows here is visible to its owner and to admins
 * only, which is exactly what deleting the last group it was shared with must leave behind.
 */
import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { documents } from './documents'
import { groups } from './groups'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const documentGroups = pgTable(
  'document_groups',
  {
    tenantId: tenantRef(tenants),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.documentId, table.groupId] }),
    index('document_groups_tenant_group_idx').on(table.tenantId, table.groupId),
    tenantIsolation('document_groups'),
  ]
)

export type DocumentGroupRow = typeof documentGroups.$inferSelect
