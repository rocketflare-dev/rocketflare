/**
 * Model pricing (D18): the table that turns the token ledger into money. Longest-prefix matching
 * (provider model ids carry dates), cache rates falling back to the input rate, and — the property
 * that matters — an unknown model priced `null` rather than guessed at.
 */
import {
  estimateCostMicrocents,
  MODEL_PRICES,
  PRICES_UPDATED,
  priceFor,
} from '@rocketflare/shared/ai/pricing'
import { describe, expect, it } from 'vitest'

describe('priceFor', () => {
  it('matches a dated model id by its longest prefix', () => {
    expect(priceFor('anthropic', 'claude-sonnet-4-5-20250929')).toEqual(
      MODEL_PRICES.anthropic?.['claude-sonnet-4']
    )
    expect(priceFor('openai', 'gpt-4.1-mini-2025-04-14')).toEqual(
      MODEL_PRICES.openai?.['gpt-4.1-mini']
    )
    // `gpt-4.1-mini` must not lose to the shorter `gpt-4.1`.
    expect(priceFor('openai', 'gpt-4.1-mini')?.input).toBe(0.4)
    expect(priceFor('openai', 'gpt-4.1')?.input).toBe(2)
  })

  it('knows nothing about a self-hosted or unlisted model', () => {
    expect(priceFor('openai_compatible', 'llama-on-my-laptop')).toBeNull()
    expect(priceFor('anthropic', 'claude-9-imaginary')).toBeNull()
    expect(priceFor('workers_ai', '@cf/some/new-model')).toBeNull()
  })

  it('records when the rates were last checked', () => {
    expect(PRICES_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('estimateCostMicrocents', () => {
  it('prices input, output and cache tiers in microcents', () => {
    // 1M input at $3 + 1M output at $15 = $18 = 1_800_000_000 microcents.
    expect(
      estimateCostMicrocents('anthropic', 'claude-sonnet-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toBe(1_800_000_000)

    // Cache reads use the cache rate ($0.30/M), not the input rate.
    expect(
      estimateCostMicrocents('anthropic', 'claude-sonnet-4-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      })
    ).toBe(30_000_000)
  })

  it('falls back to the input rate for a provider with no cache tier', () => {
    const withCache = estimateCostMicrocents('workers_ai', '@cf/baai/bge-m3', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    })
    const asInput = estimateCostMicrocents('workers_ai', '@cf/baai/bge-m3', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(withCache).toBe(asInput)
  })

  it('is null — never zero — for a model with no price', () => {
    expect(
      estimateCostMicrocents('openai_compatible', 'mystery', {
        inputTokens: 5_000,
        outputTokens: 5_000,
      })
    ).toBeNull()
  })
})
