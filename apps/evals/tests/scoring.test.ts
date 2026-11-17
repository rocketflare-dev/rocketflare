/** The deterministic scorers: trajectory semantics per agentevals, and the rest. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  averagePrecision,
  budgetScore,
  conflictDetectionScore,
  containsScore,
  decisionScore,
  entityIndex,
  expectedToolNames,
  factExtractionScore,
  matchFacts,
  normalizeName,
  outputText,
  passageCovered,
  passageRanks,
  recallAtK,
  reciprocalRank,
  regexScore,
  schemaScore,
  trajectoryScore,
  valuesMatch,
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

describe('retrieval scorers', () => {
  const hits = [
    { doc: 'b', text: 'Something else entirely.' },
    { doc: 'a', text: 'Intro.\n\nThe annual plan costs   £1,140 per site. More.' },
    { doc: 'a', text: 'renews on 31 January' },
  ]

  it('finds a passage whitespace- and case-blind, or split across a chunk boundary', () => {
    expect(passageCovered(hits[1].text, 'the annual plan costs £1,140 per site.')).toBe(true)
    expect(
      passageCovered(
        '… and this agreement renews on 31',
        'This agreement renews on 31 January 2027'
      )
    ).toBe(true)
    expect(
      passageCovered('January 2027. Next clause.', 'This agreement renews on 31 January 2027')
    ).toBe(false)
  })

  it('ranks, recalls and reciprocates', () => {
    const ranks = passageRanks(hits, [
      { doc: 'a', passage: 'The annual plan costs £1,140 per site.' },
      { doc: 'a', passage: 'not there' },
      { doc: 'b', passage: 'The annual plan costs £1,140 per site.' },
    ])
    expect(ranks).toEqual([2, null, null])
    expect(recallAtK(ranks, 1).score).toBe(0)
    expect(recallAtK(ranks, 5).score).toBeCloseTo(1 / 3)
    expect(reciprocalRank(ranks).score).toBe(0.5)
    expect(reciprocalRank([null]).score).toBe(0)
  })

  it('scores average precision toward the top', () => {
    expect(averagePrecision([true, false, true]).score).toBeCloseTo((1 + 2 / 3) / 2)
    expect(averagePrecision([false, false]).score).toBe(0)
    expect(averagePrecision([]).score).toBe(0)
  })
})

describe('fact scorers', () => {
  const index = entityIndex([
    { entityType: 'customer', name: 'Harbour View Dental', aliases: ['HVD'] },
  ])
  const planted = [
    {
      id: 'f1',
      entityType: 'customer',
      entity: 'Harbour View Dental',
      key: 'monthly_fee_gbp',
      value: 95,
      doc: 'd1',
    },
    {
      id: 'f2',
      entityType: 'customer',
      entity: 'Harbour View Dental',
      key: 'service_plan',
      value: 'Premium',
      doc: 'd1',
    },
    {
      id: 'f3',
      entityType: 'customer',
      entity: 'Harbour View Dental',
      key: 'monthly_fee_gbp',
      value: 110,
      doc: 'd2',
    },
  ]

  it('normalises values', () => {
    expect(valuesMatch(95, '£95.00')).toBe(true)
    expect(valuesMatch('1,140', 1140)).toBe(true)
    expect(valuesMatch(' premium ', 'Premium')).toBe(true)
    expect(valuesMatch(['Standard', 'Premium'], ['premium', 'standard'])).toBe(true)
    expect(valuesMatch(true, 'true')).toBe(false)
    expect(valuesMatch('2027-01-31', '2027-01-31')).toBe(true)
  })

  it('matches through aliases, per document, each planted fact once', () => {
    const extracted = [
      { entityType: 'customer', entity: 'hvd', key: 'monthly_fee_gbp', value: '95', doc: 'd1' },
      { entityType: 'customer', entity: 'HVD', key: 'monthly_fee_gbp', value: 95, doc: 'd1' },
      {
        entityType: 'customer',
        entity: 'Harbour View Dental',
        key: 'monthly_fee_gbp',
        value: 110,
        doc: 'd1',
      },
    ]
    expect(matchFacts(extracted, planted, index)).toEqual(['f1', null, null])
    const s = factExtractionScore(extracted, planted, index)
    expect(s.precision).toBeCloseTo(1 / 3)
    expect(s.recall).toBeCloseTo(1 / 3)
  })

  it('counts caught conflicts and false alarms', () => {
    const s = conflictDetectionScore(
      [
        ['f3', 'f1'],
        ['f1', 'f2'],
      ],
      [{ a: 'f1', b: 'f3' }],
      1
    )
    expect(s.caught).toBe(1)
    expect(s.falseAlarmRate).toBeCloseTo(2 / 3)
    expect(conflictDetectionScore([], []).score).toBe(1)
  })
})

describe('normalizeName', () => {
  it('drops case, punctuation and a trailing legal form', () => {
    expect(normalizeName('Harbour View Dental, Ltd.')).toBe('harbour view dental')
    expect(normalizeName('Kingsgate Estates Limited')).toBe('kingsgate estates')
    expect(normalizeName('Northern Salt & Grit Co')).toBe('northern salt grit')
    expect(normalizeName('Coleridge Inc Ltd')).toBe('coleridge')
    expect(normalizeName('Colton')).toBe('colton')
  })
})
