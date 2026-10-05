/**
 * `memory_groups` (D29, D36) — which groups a `visibility: 'groups'` memory is shared with. The
 * `document_groups` shape exactly: one junction per resource with real cascading FKs, and rows
 * that GRANT, never decide — `memories.visibility` decides. Phase 1 writes no rows here (every
 * memory it learns is `private`); it exists so the registry entry, the `group_in_use` count and
 * the visibility predicate are already true when knowledge-derived memory arrives.
 */
import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { groups } from './groups'
import { memories } from './memories'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const memoryGroups = pgTable(
  'memory_groups',
  {
    tenantId: tenantRef(tenants),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.memoryId, table.groupId] }),
    index('memory_groups_tenant_group_idx').on(table.tenantId, table.groupId),
    tenantIsolation('memory_groups'),
  ]
)

export type MemoryGroupRow = typeof memoryGroups.$inferSelect
