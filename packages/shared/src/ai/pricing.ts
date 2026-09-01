/**
 * Model prices (D18) — the table that turns the token ledger into money.
 *
 * `ai_usage` records tokens because tokens are a fact; a price is a guess about someone else's
 * rate card. This file is that guess, kept in ONE place so an app can correct it without touching
 * any call site: `recordUsage` freezes a row's cost from it at write time (so a later price change
 * cannot rewrite history), and the usage summary prices older rows that have no stored cost with
 * the same helper.
 *
 * **These are published list prices in USD per million tokens as of `PRICES_UPDATED`, and they go
 * stale.** Check them against your provider's page before showing them to anyone who cares, and
 * treat the figures in the app as an estimate — which is what the Usage page calls them. A model
 * that is not in the table is priced `null` (shown as "—"), never guessed at: a wrong number is
 * worse than no number.
 */

import type { TokenUsage } from './chat'
import type { AiProvider } from './config'

/** When the rates below were last checked, ISO date. Update it when you edit a price. */
export const PRICES_UPDATED = '2026-09-01'

/** USD per MILLION tokens. `cacheRead`/`cacheWrite` default to the input rate when absent. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Keyed by provider, then by a model-id PREFIX — provider ids carry dates and suffixes
 * (`claude-sonnet-4-5-20250929`), so the longest matching prefix wins. `openai_compatible` and
 * `anthropic_compatible` have no entries by design: they point at whatever host an app configured,
 * whose rates only that app knows.
 */
export const MODEL_PRICES: Partial<Record<AiProvider, Record<string, ModelPrice>>> = {
  anthropic: {
    'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  openai: {
    'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 },
    'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
    'text-embedding-3-small': { input: 0.02, output: 0 },
    'text-embedding-3-large': { input: 0.13, output: 0 },
  },
  workers_ai: {
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.29, output: 2.25 },
    '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 0.35, output: 0.56 },
    '@cf/baai/bge-m3': { input: 0.012, output: 0 },
    '@cf/baai/bge-large-en-v1.5': { input: 0.204, output: 0 },
  },
}

/** The price for a model id, by longest matching prefix; null when the table does not know it. */
export function priceFor(provider: AiProvider, model: string): ModelPrice | null {
  const table = MODEL_PRICES[provider]
  if (!table) return null
  const id = model.trim().toLowerCase()
  let best: { key: string; price: ModelPrice } | null = null
  for (const [key, price] of Object.entries(table)) {
    const candidate = key.toLowerCase()
    if (!id.startsWith(candidate)) continue
    if (!best || candidate.length > best.key.length) best = { key: candidate, price }
  }
  return best?.price ?? null
}

/** Microcents (1/1 000 000 of a cent) per USD — the `ai_usage.cost_microcents` unit. */
const MICROCENTS_PER_USD = 100_000_000
const PER_TOKEN = 1_000_000

/**
 * What a call cost, in microcents, or null when the model has no price. Cache reads and writes
 * fall back to the input rate, which is what a provider without a cache tier effectively charges.
 */
export function estimateCostMicrocents(
  provider: AiProvider,
  model: string,
  usage: TokenUsage
): number | null {
  const price = priceFor(provider, model)
  if (!price) return null
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) +
      (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) /
    PER_TOKEN
  return Math.round(usd * MICROCENTS_PER_USD)
}
