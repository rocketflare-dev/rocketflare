/**
 * `files` — the index of objects stored in the `FILES` R2 bucket (D23). R2 holds the bytes under
 * `key`; this row holds who owns them, in which tenant, and what to serve them as. Rows are
 * immutable (upload = insert, replace = new row), so there is no `updated_at`. `scope` groups
 * uploads by purpose (`avatars` is the kit's example; `documents` holds knowledge-base originals
 * owned by a `documents` row); `key` is unique because it embeds a UUID.
 */
import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `FILE_SCOPES` in `@rocketflare/shared/files` — the DB enum and the contract must agree. */
export const FILE_SCOPES = ['avatars', 'uploads', 'documents'] as const
export type FileScope = (typeof FILE_SCOPES)[number]

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: FILE_SCOPES }).notNull(),
    /** R2 object key: `tenants/<tenantId>/<scope>/<uuid>-<sanitised filename>`. */
    key: text('key').notNull().unique(),
    /** The client's original filename, sanitised — for `Content-Disposition` and listings. */
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('files_tenant_owner_idx').on(table.tenantId, table.ownerUserId),
    tenantIsolation('files'),
  ]
)

export const filesRelations = relations(files, ({ one }) => ({
  tenant: one(tenants, { fields: [files.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [files.ownerUserId], references: [users.id] }),
}))

export type FileRow = typeof files.$inferSelect
export type NewFileRow = typeof files.$inferInsert
