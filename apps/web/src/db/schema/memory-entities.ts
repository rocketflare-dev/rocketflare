/**
 * The graph half of memory (D36): the people, places, projects and things facts name, and which
 * facts name them. Hindsight's `entities` + `unit_entities`, in the kit's tenancy.
 *
 * An entity belongs to the SAME partition as the facts that name it — `(tenant, owner)` — so one
 * person's "Alice" is never merged with another's, and following an entity can never cross from
 * one person's memory into another's. Resolution is by `normalisedName` (lower-cased, whitespace
 * collapsed), unique per partition: deliberately exact, because a fuzzy merge that joins "John
 * Smith" to "Jane Smith" is a wrong answer the reader cannot see. Trigram matching is the
 * documented next step (`docs/CONCEPTS.md` §9).
 */
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { memories } from './memories'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const memoryEntities = pgTable(
  'memory_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** Same partition as the facts; null only for knowledge-owned entities (none in phase 1). */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** As first seen — what the UI shows. */
    name: text('name').notNull(),
    /** `normaliseEntityName(name)` — the resolution key. */
    normalisedName: text('normalised_name').notNull(),
    mentionCount: integer('mention_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  table => [
    unique('memory_entities_partition_name_uq')
      .on(table.tenantId, table.ownerUserId, table.normalisedName)
      .nullsNotDistinct(),
    tenantIsolation('memory_entities'),
  ]
)

/** Which facts name which entities — the edge list entity recall walks. */
export const memoryEntityLinks = pgTable(
  'memory_entity_links',
  {
    tenantId: tenantRef(tenants),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => memoryEntities.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.memoryId, table.entityId] }),
    index('memory_entity_links_tenant_entity_idx').on(table.tenantId, table.entityId),
    tenantIsolation('memory_entity_links'),
  ]
)

export type MemoryEntityRow = typeof memoryEntities.$inferSelect
export type MemoryEntityLinkRow = typeof memoryEntityLinks.$inferSelect
