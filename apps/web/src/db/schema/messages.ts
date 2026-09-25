/**
 * `messages` — the turns of a conversation (D17). `tenantId` is denormalised from the conversation
 * so the RLS policy and the tenant predicate apply directly. `toolCalls` records what the assistant
 * called (zero default tools in the kit — the column exists so a tool surface needs no migration);
 * `usage` is the provider's token report for an assistant turn (also written to `ai_usage`, D18),
 * and `provider`/`model` record which model produced it — the turn re-resolves its client every
 * time, so this is the only place a mixed-model thread can be priced or explained.
 * The read index is `(conversation_id, created_at)` — a deliberate exception to the tenant-first
 * rule: a thread is always fetched by its id after an ownership check on `conversations`.
 */
import type { ChatRole, TokenUsage, ToolCallRecord } from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { conversations } from './conversations'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const CHAT_ROLES = [
  'user',
  'assistant',
  'system',
  'tool',
] as const satisfies readonly ChatRole[]

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tenantId: tenantRef(tenants),
    role: text('role', { enum: CHAT_ROLES }).notNull(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>(),
    usage: jsonb('usage').$type<TokenUsage>(),
    /**
     * What actually answered this turn. Nullable: null on a user row, and on every assistant row
     * written before these columns existed — a stats surface must render "unknown", never guess.
     */
    provider: text('provider').$type<AiProvider>(),
    model: text('model'),
    /** The OTLP trace of the turn that produced this assistant row (D32); null on a user row. */
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    tenantIsolation('messages'),
  ]
)

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  tenant: one(tenants, { fields: [messages.tenantId], references: [tenants.id] }),
}))

export type MessageRow = typeof messages.$inferSelect
export type NewMessageRow = typeof messages.$inferInsert
