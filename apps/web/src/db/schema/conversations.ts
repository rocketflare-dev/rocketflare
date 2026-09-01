/**
 * `conversations` — one persisted chat thread per user (D17). Ownership is `userId`: the routes
 * filter by BOTH `tenantId` (auth context) and `userId`, so another member's thread — admin or
 * not — is a 404. `provider`/`model` are frozen at creation so the transcript records what
 * answered. `lastMessageAt` orders the list; `title` is set from the first user message.
 */
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New conversation'),
    provider: text('provider').$type<AiProvider>().notNull(),
    model: text('model').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    index('conversations_tenant_user_recent_idx').on(
      table.tenantId,
      table.userId,
      table.lastMessageAt.desc()
    ),
    tenantIsolation('conversations'),
  ]
)

export const conversationsRelations = relations(conversations, ({ one }) => ({
  tenant: one(tenants, { fields: [conversations.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
}))

export type ConversationRow = typeof conversations.$inferSelect
export type NewConversationRow = typeof conversations.$inferInsert
