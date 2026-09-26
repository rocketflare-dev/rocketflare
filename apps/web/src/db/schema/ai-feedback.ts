/**
 * `ai_feedback` — a person's thumbs up/down on an AI answer (D33): an assistant message or an agent
 * run's output. One row per `(tenant, target, user)`: voting again replaces the vote, withdrawing
 * it deletes the row. The list is the evals promotion queue (`rocketflare feedback list --rating
 * down` → `rocketflare evals promote`).
 *
 * `target_id` is a plain uuid with no foreign key, like `ai_spans.run_id`: it points at one of two
 * tables, and a rating is a record of what somebody thought of an answer — deleting the thread must
 * not quietly rewrite what the promotion queue says. `trace_id` is copied from the rated row so the
 * feedback span lands in the answer's own trace (`rocketflare traces show`).
 */
import type { FeedbackTarget } from '@rocketflare/shared/ai/evals'
import { relations } from 'drizzle-orm'
import { index, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const aiFeedback = pgTable(
  'ai_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    target: text('target').$type<FeedbackTarget>().notNull(),
    targetId: uuid('target_id').notNull(),
    /** `1` up, `-1` down. */
    rating: smallint('rating').$type<1 | -1>().notNull(),
    comment: text('comment'),
    /** Null once the user is deleted: the rating outlives the account, like an activity row. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    traceId: text('trace_id'),
    ...timestamps(),
  },
  table => [
    uniqueIndex('ai_feedback_tenant_target_user_idx').on(
      table.tenantId,
      table.target,
      table.targetId,
      table.userId
    ),
    index('ai_feedback_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    tenantIsolation('ai_feedback'),
  ]
)

export const aiFeedbackRelations = relations(aiFeedback, ({ one }) => ({
  tenant: one(tenants, { fields: [aiFeedback.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [aiFeedback.userId], references: [users.id] }),
}))

export type AiFeedbackRow = typeof aiFeedback.$inferSelect
export type NewAiFeedbackRow = typeof aiFeedback.$inferInsert
