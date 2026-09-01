/**
 * AI usage ledger (D18): `recordUsage` writes one `ai_usage` row from a provider's usage report,
 * `tapUsage` wraps a `ChatClient` so every generation reports through one callback (the chat
 * route records; agents will too), and `summarizeUsage` answers `GET /api/ai/usage/summary`.
 *
 * Cost comes from ONE table, `@rocketflare/shared/ai/pricing`: `recordUsage` freezes a row's cost
 * from it at write time (a later price edit cannot rewrite history), and the summary prices rows
 * that have no stored cost — written before the table existed, or by a caller that passed none —
 * with the same helper, so the page is not half empty. A model the table does not know stays null
 * and shows as "—"; the summary counts those calls in `unpricedCalls` so the UI can say the total
 * is partial.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { estimateCostMicrocents } from '@rocketflare/shared/ai/pricing'
import type { AiUsageRowSummary, AiUsageSummary } from '@rocketflare/shared/ai/usage'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { aiUsage } from '../../../db/schema'
import type { ChatClient, ChatResult } from './types'

export interface UsageInput {
  tenantId: string
  userId?: string | null
  feature: string
  provider: AiProvider
  model: string
  usage: TokenUsage
  costMicrocents?: number | null
}

export async function recordUsage(db: Database, input: UsageInput): Promise<void> {
  const cost =
    input.costMicrocents ?? estimateCostMicrocents(input.provider, input.model, input.usage)
  await db.insert(aiUsage).values({
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    feature: input.feature,
    provider: input.provider,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
    costMicrocents: cost,
  })
}

export type UsageTap = (usage: TokenUsage, result: ChatResult) => void | Promise<void>

/** Wrap a client so every `complete`/`stream` result reports its usage. The tap must not throw. */
export function tapUsage(client: ChatClient, onUsage: UsageTap): ChatClient {
  const report = (result: ChatResult) => {
    void Promise.resolve(onUsage(result.usage, result)).catch(() => {})
  }
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      const result = await client.complete(params)
      report(result)
      return result
    },
    async *stream(params) {
      for await (const delta of client.stream(params)) {
        if (delta.type === 'end') report(delta.result)
        yield delta
      }
    },
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function summarizeUsage(
  db: Database,
  tenantId: string,
  range: { from?: Date; to?: Date } = {}
): Promise<AiUsageSummary> {
  const to = range.to ?? new Date()
  const from = range.from ?? new Date(to.getTime() - 30 * DAY_MS)
  // No upper bound unless the caller set one: a row stamped by Postgres `now()` can sit a few ms
  // ahead of this isolate's clock, and "everything so far" must include it.
  const upper = range.to ? lt(aiUsage.at, range.to) : undefined
  const grouped = await db
    .select({
      provider: aiUsage.provider,
      model: aiUsage.model,
      feature: aiUsage.feature,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::bigint`,
      cacheWriteTokens: sql<number>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::bigint`,
      costMicrocents: sql<number | null>`sum(${aiUsage.costMicrocents})::bigint`,
      // Rows written before this model had a price: priced below from their tokens.
      unpricedCalls: sql<number>`count(*) filter (where ${aiUsage.costMicrocents} is null)::int`,
      unpricedInput: sql<number>`coalesce(sum(${aiUsage.inputTokens}) filter (where ${aiUsage.costMicrocents} is null), 0)::bigint`,
      unpricedOutput: sql<number>`coalesce(sum(${aiUsage.outputTokens}) filter (where ${aiUsage.costMicrocents} is null), 0)::bigint`,
      unpricedCacheRead: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}) filter (where ${aiUsage.costMicrocents} is null), 0)::bigint`,
      unpricedCacheWrite: sql<number>`coalesce(sum(${aiUsage.cacheWriteTokens}) filter (where ${aiUsage.costMicrocents} is null), 0)::bigint`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.at, from), upper))
    .groupBy(aiUsage.provider, aiUsage.model, aiUsage.feature)
    .orderBy(aiUsage.provider, aiUsage.model, aiUsage.feature)

  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
  const rows: AiUsageRowSummary[] = grouped.map(r => {
    const stored =
      r.costMicrocents === null || r.costMicrocents === undefined ? null : Number(r.costMicrocents)
    const unpricedCalls = num(r.unpricedCalls)
    // One (provider, model) per group, so one price covers every unpriced row in it.
    const estimated =
      unpricedCalls === 0
        ? 0
        : estimateCostMicrocents(r.provider, r.model, {
            inputTokens: num(r.unpricedInput),
            outputTokens: num(r.unpricedOutput),
            cacheReadTokens: num(r.unpricedCacheRead),
            cacheWriteTokens: num(r.unpricedCacheWrite),
          })
    const total = estimated === null ? stored : (stored ?? 0) + estimated
    return {
      provider: r.provider,
      model: r.model,
      feature: r.feature,
      calls: num(r.calls),
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      cacheWriteTokens: num(r.cacheWriteTokens),
      costMicrocents: total,
      // Calls with no price at all — the model is not in the table.
      unpricedCalls: estimated === null ? unpricedCalls : 0,
    }
  })
  const anyCost = rows.some(r => r.costMicrocents !== null)
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costMicrocents: anyCost ? (acc.costMicrocents ?? 0) + (r.costMicrocents ?? 0) : null,
      unpricedCalls: acc.unpricedCalls + r.unpricedCalls,
    }),
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrocents: anyCost ? 0 : null,
      unpricedCalls: 0,
    } as AiUsageSummary['totals']
  )
  return { from, to, rows, totals }
}
