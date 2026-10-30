/** The deterministic scorers: trajectory semantics per agentevals, and the rest. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  budgetScore,
  containsScore,
  decisionScore,
  expectedToolNames,
  outputText,
  regexScore,
  schemaScore,
  trajectoryScore,
} from '../kit/scoring'

describe('trajectoryScore', () => {
  const s = (actual: string[], expected: string[], mode: Parameters<typeof trajectoryScore>[2]) =>
    trajectoryScore(actual, expected, mode).score

  it('strict: same tools, same order, same count', () => {
    expect(s(['a', 'b'], ['a', 'b'], 'strict')).toBe(1)
    expect(s(['b', 'a'], ['a', 'b'], 'strict')).toBe(0)
    expect(s(['a'], ['a', 'a'], 'strict')).toBe(0)
    expect(s([], [], 'strict')).toBe(1)
    expect(s(['a'], [], 'strict')).toBe(0)
  })

  it('unordered: same multiset', () => {
    expect(s(['b', 'a'], ['a', 'b'], 'unordered')).toBe(1)
    expect(s(['a', 'a'], ['a'], 'unordered')).toBe(0)
  })

  it('subset: nothing outside the expected set', () => {
    expect(s(['a'], ['a', 'b'], 'subset')).toBe(1)
    expect(s(['a', 'c'], ['a', 'b'], 'subset')).toBe(0)
    expect(s([], ['a'], 'subset')).toBe(1)
  })

  it('superset: every expected tool at least once', () => {
    expect(s(['a', 'b', 'c'], ['a', 'b'], 'superset')).toBe(1)
    expect(s(['a'], ['a', 'b'], 'superset')).toBe(0)
    expect(s(['x'], [], 'superset')).toBe(1)
  })

  it('explains itself', () => {
    expect(trajectoryScore([], ['search_knowledge'], 'superset').rationale).toBe(
      'called (no tools); expected search_knowledge (superset)'
    )
  })
})

describe('the other scorers', () => {
  it('containsScore is a case-insensitive fraction naming what is missing', () => {
    expect(containsScore('Refunds within 30 DAYS', ['30 days', 'unused'])).toEqual({
      score: 0.5,
      rationale: 'missing "unused"',
    })
    expect(containsScore('x', []).score).toBe(1)
  })

  it('regexScore, schemaScore', () => {
    expect(regexScore('order #1234', /#\d{4}/).score).toBe(1)
    const schema = z.object({ summary: z.string().min(1) })
    expect(schemaScore({ summary: 'ok' }, schema).score).toBe(1)
    expect(schemaScore({ summary: '' }, schema)).toMatchObject({ score: 0 })
    expect(schemaScore({ summary: '' }, schema).rationale).toContain('summary')
  })

  it('budgetScore fails each limit exceeded and never fails an unknown cost', () => {
    expect(
      budgetScore({ totalMs: 10, inputTokens: 5, outputTokens: 5 }, { maxMs: 100 }).score
    ).toBe(1)
    const over = budgetScore(
      { totalMs: 500, inputTokens: 900, outputTokens: 200 },
      { maxMs: 100, maxTokens: 1000 }
    )
    expect(over.score).toBe(0)
    expect(over.rationale).toBe('over budget: 500ms > 100ms, 1100 tokens > 1000')
    expect(budgetScore({}, { maxCostUsd: 0.01 }).score).toBe(1)
  })

  it('expectedToolNames and outputText', () => {
    expect(expectedToolNames(['a', { name: 'b', arguments: { q: 1 } }])).toEqual(['a', 'b'])
    expect(outputText(null)).toBe('')
    expect(outputText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('decisionScore', () => {
  const recorded = {
    answerable: { answerable: { type: 'noul' as const, label: 'yes', confidence: 0.8, noul: 0.9 } },
    route: {
      team: {
        type: 'choice' as const,
        label: 'billing',
        confidence: 0.4,
        probabilities: { billing: 0.6, support: 0.4 },
      },
    },
  }

  it('scores accuracy per expected question and reports the Brier score', () => {
    const all = decisionScore(recorded, {
      answerable: { answerable: 'yes' },
      route: { team: 'billing' },
    })
    expect(all.score).toBe(1)
    // noul (0.9 − 1)² = 0.01; choice ((0.6 − 1)² + 0.4²) / 2 = 0.16 → mean 0.085
    expect(all.brier).toBeCloseTo(0.085)
    expect(all.rationale).toContain('Brier')

    const half = decisionScore(recorded, {
      answerable: { answerable: 'no' },
      route: { team: 'billing' },
    })
    expect(half.score).toBe(0.5)
    expect(half.rationale).toContain('answerable.answerable: yes ≠ no')
  })

  it('counts a question the run never asked as wrong', () => {
    const r = decisionScore(recorded, { screen: { item_0: 'yes' } })
    expect(r.score).toBe(0)
    expect(r.rationale).toContain('not asked')
  })
})
