/**
 * AI usage contracts (D18): one `ai_usage` row per generation, written from the provider's usage
 * tap (`services/ai/usage.ts`), and the per-model summary `GET /api/ai/usage/summary` returns.
 * `costMicrocents` is nullable — the kit records tokens and prices them from
 * `@rocketflare/shared/ai/pricing`, which an app corrects; a model the table does not know stays
 * null and is counted in `unpricedCalls`, so a partial total says so instead of pretending.
 */
import { z } from 'zod'
import { aiProviderSchema } from './config'

export const aiUsageSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  /** What spent it: a prompt key (`chat`, `summarize-text`) or a feature name (`connection-test`). */
  feature: z.string(),
  provider: aiProviderSchema,
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** 1/1,000,000 of a cent; null until an app supplies pricing. */
  costMicrocents: z.number().int().nullable(),
  at: z.coerce.date(),
})
export type AiUsage = z.infer<typeof aiUsageSchema>

export const aiUsageRowSummarySchema = z.object({
  provider: aiProviderSchema,
  model: z.string(),
  feature: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Estimated from the price table (or frozen at write time); null when the model has no price. */
  costMicrocents: z.number().int().nullable(),
  /** Calls in this group with no price — the model is not in the table. */
  unpricedCalls: z.number().int().nonnegative(),
})
export type AiUsageRowSummary = z.infer<typeof aiUsageRowSummarySchema>

/** `GET /api/ai/usage/summary?from&to` — totals per (provider, model, feature) plus grand totals. */
export const aiUsageSummarySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  rows: z.array(aiUsageRowSummarySchema),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nullable(),
    unpricedCalls: z.number().int().nonnegative(),
  }),
})
export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>

/** Defaults: the last 30 days. Dates are ISO strings on the wire. */
export const aiUsageSummaryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type AiUsageSummaryQuery = z.infer<typeof aiUsageSummaryQuerySchema>
