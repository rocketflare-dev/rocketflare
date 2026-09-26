/**
 * What a case cost (D33), read from the ledger rather than from the stream: every model call the
 * kit makes is an `ai_usage` row (`recordUsage`), priced at write time from the shared price table.
 * A case runs in its own tenant, so "every row in the tenant except the judge's" is exactly the
 * target's spend — chat turn, agent tool loop and anything they triggered.
 */
import { createHash } from 'node:crypto'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { UsageSummary } from 'vitest-evals'
import type { Database } from '@/db/client'
import { aiUsage } from '@/db/schema'

export const JUDGE_FEATURE = 'evals.judge'

export async function tenantSpend(
  db: Database,
  tenantId: string
): Promise<Pick<UsageSummary, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd'>> {
  const [row] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
      cost: sql<number | null>`sum(${aiUsage.costMicrocents})::float8`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenantId), ne(aiUsage.feature, JUDGE_FEATURE)))
  const inputTokens = Number(row?.input ?? 0)
  const outputTokens = Number(row?.output ?? 0)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    // microcents → USD. Null (an unpriced model) stays unknown rather than reading as free.
    ...(row?.cost !== null && row?.cost !== undefined ? { costUsd: Number(row.cost) / 1e8 } : {}),
  }
}

/** A short, stable hash of the prompt text a case ran with — what `--compare` groups runs by. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}
