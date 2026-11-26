/**
 * `pending_uploads` — an upload that has been authorised (`POST /api/uploads`) but not yet
 * confirmed. The browser holds a one-shot `PUT` URL for `key`; this row is what `confirm` checks
 * the arrived object against, and what the nightly prune uses to delete an object that was never
 * confirmed. Confirm CLAIMS the row (`confirmed_at`, compare-and-set), so an upload is confirmed
 * once. The row outlives the confirm until its URL is dead: a failed confirm deletes the object and
 * un-claims the row, so a second `PUT` to the still-valid URL is pruned rather than orphaned.
 *
 * `target` is a core target (`avatars`, `uploads`, `documents`) or a plugin's `<id>.<name>`;
 * `bucket` is the R2 binding the object went to, so the prune can delete it without the target.
 * `state` carries what `prepare` decided for `confirm` (a document's title, visibility, groups).
 * `tokenHash` is set only on the local Worker `PUT` (no S3 credentials): SHA-256 of the URL's token.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const pendingUploads = pgTable(
  'pending_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    tokenHash: text('token_hash'),
    /** Set when `confirm` claims the row; reset if it fails, so the prune still sees the key. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('pending_uploads_tenant_expires_idx').on(table.tenantId, table.expiresAt),
    tenantIsolation('pending_uploads'),
  ]
)

export type PendingUploadRow = typeof pendingUploads.$inferSelect
