/**
 * AI usage contracts (D18): one `ai_usage` row per generation, written from the provider's usage
 * tap (`services/ai/usage.ts`), and the per-model summary `GET /api/ai/usage/summary` returns.
 * `costMicrocents` is nullable — the kit records tokens; pricing is an app-level table.
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
  costMicrocents: z.number().int().nullable(),
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
  }),
})
export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>

/** Defaults: the last 30 days. Dates are ISO strings on the wire. */
export const aiUsageSummaryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type AiUsageSummaryQuery = z.infer<typeof aiUsageSummaryQuerySchema>
