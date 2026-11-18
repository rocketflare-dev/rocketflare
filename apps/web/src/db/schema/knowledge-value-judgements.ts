/**
 * `knowledge_value_judgements` — what a decision model answered when two facts about ONE entity
 * and key had different values (D43): do they say the same thing (`same`), is one a more specific
 * form of the other (`compatible` — "Marcus" / "Marcus Bell"), or do they disagree (`different`)?
 *
 * Code compares values literally (`valueKey`) and asks only about the pairs that differ; the answer
 * is stored here so every later decision about that entity and key — the next document, a re-read
 * of this one, `recomputeKey` after a merge — reads it instead of asking again. It is keyed on the
 * two comparison keys (`value_a` < `value_b`), not on fact ids, so it survives re-extraction.
 *
 * Only a CONFIDENT `same` / `compatible` changes anything (`decideFactState`): every other answer
 * is stored as `different` — today's literal rule — so a weak model can only remove false alarms,
 * never hide a real disagreement. `method` says whether the answer was calibrated (`typesafe`) or
 * a chat model's own estimate (`llm_self_report`).
 */
import { DECISION_METHODS } from '@rocketflare/shared/ai/decisions'
import { ENTITY_KINDS } from '@rocketflare/shared/ai/knowledge-facts'
import { sql } from 'drizzle-orm'
import { check, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const VALUE_VERDICTS = ['same', 'compatible', 'different'] as const
export type ValueVerdict = (typeof VALUE_VERDICTS)[number]

export const knowledgeValueJudgements = pgTable(
  'knowledge_value_judgements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    entityKind: text('entity_kind', { enum: ENTITY_KINDS }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    key: text('key').notNull(),
    /** The two `valueKey`s, `value_a` < `value_b`. */
    valueA: text('value_a').notNull(),
    valueB: text('value_b').notNull(),
    verdict: text('verdict', { enum: VALUE_VERDICTS }).notNull(),
    confidence: real('confidence').notNull(),
    method: text('method', { enum: DECISION_METHODS }).notNull(),
    model: text('model').notNull(),
    ...timestamps(),
  },
  table => [
    uniqueIndex('knowledge_value_judgements_pair_idx').on(
      table.tenantId,
      table.entityKind,
      table.entityType,
      table.entityId,
      table.key,
      table.valueA,
      table.valueB
    ),
    check('knowledge_value_judgements_order', sql`${table.valueA} < ${table.valueB}`),
    check('knowledge_value_judgements_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
    tenantIsolation('knowledge_value_judgements'),
  ]
)

export type KnowledgeValueJudgementRow = typeof knowledgeValueJudgements.$inferSelect
