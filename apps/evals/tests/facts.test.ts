/**
 * The facts suite's scoring (`kit/facts.ts`), no model and no database: which stored links count
 * as a flagged conflict, how they map to planted ids, and which side is preferred. And the corpus
 * types it registers must pass the app's own registry rules.
 */
import { describe, expect, it } from 'vitest'
import { entityTypeIssues } from '@/api/services/knowledge/registry'
import type { Corpus } from '../kit/corpus'
import { corpusEntityTypes, type StoredFact, scoreConflicts } from '../kit/facts'

const corpus = {
  name: 'fixture',
  dir: '',
  docs: [],
  retrieval: [],
  chat: [],
  entities: [{ entityType: 'customer', name: 'Acme', aliases: ['Acme Ltd'] }],
  facts: [
    {
      id: 'fee-a',
      entityType: 'customer',
      entity: 'Acme',
      key: 'fee',
      value: 10,
      doc: 'a',
      quote: 'q',
      validFrom: null,
      validTo: null,
    },
    {
      id: 'fee-b',
      entityType: 'customer',
      entity: 'Acme',
      key: 'fee',
      value: 12,
      doc: 'b',
      quote: 'q',
      validFrom: null,
      validTo: null,
    },
    {
      id: 'who-a',
      entityType: 'customer',
      entity: 'Acme',
      key: 'who',
      value: 'Ann',
      doc: 'a',
      quote: 'q',
      validFrom: null,
      validTo: null,
    },
    {
      id: 'who-b',
      entityType: 'customer',
      entity: 'Acme',
      key: 'who',
      value: 'Bob',
      doc: 'a',
      quote: 'q',
      validFrom: null,
      validTo: null,
    },
  ],
  conflicts: [
    {
      id: 'fee',
      entityType: 'customer',
      entity: 'Acme',
      key: 'fee',
      a: 'fee-a',
      b: 'fee-b',
      winner: 'a',
      why: '',
    },
  ],
} as unknown as Corpus

const fact = (
  over: Partial<StoredFact> & Pick<StoredFact, 'factId' | 'key' | 'value' | 'doc'>
): StoredFact => ({
  entityType: 'customer',
  entity: 'Acme Ltd',
  documentId: over.doc,
  state: 'accepted',
  conflictsWith: [],
  supersededById: null,
  observedAt: new Date('2026-01-01'),
  sourceKind: 'upload',
  ...over,
})

describe('scoreConflicts', () => {
  it('a conflicts_with pair is a flag; the trusted older side wins over a newer integration', () => {
    const out = scoreConflicts({
      corpus,
      facts: [
        fact({
          factId: '1',
          key: 'fee',
          value: 10,
          doc: 'a',
          state: 'conflicting',
          conflictsWith: ['2'],
        }),
        fact({
          factId: '2',
          key: 'fee',
          value: 12,
          doc: 'b',
          state: 'conflicting',
          conflictsWith: ['1'],
          observedAt: new Date('2026-06-01'),
          sourceKind: 'integration',
        }),
      ],
    })
    expect(out).toMatchObject({ caught: 1, falseAlarmRate: 0, winnerAccuracy: 1, missed: [] })
  })

  it('a supersession across documents is a flag won by the superseding fact; inside one document it is not', () => {
    const across = scoreConflicts({
      corpus,
      facts: [
        fact({
          factId: '1',
          key: 'fee',
          value: 10,
          doc: 'a',
          state: 'superseded',
          supersededById: '2',
        }),
        fact({ factId: '2', key: 'fee', value: 12, doc: 'b' }),
      ],
    })
    expect(across).toMatchObject({ caught: 1, winnerAccuracy: 0 }) // planted winner is a
    const within = scoreConflicts({
      corpus,
      facts: [
        fact({
          factId: '3',
          key: 'who',
          value: 'Ann',
          doc: 'a',
          state: 'superseded',
          supersededById: '4',
        }),
        fact({ factId: '4', key: 'who', value: 'Bob', doc: 'a' }),
      ],
    })
    expect(within).toMatchObject({ caught: 0, falseAlarmRate: 0, flagged: [] })
  })

  it('a flag on a fact the answer key does not hold is a false alarm', () => {
    const out = scoreConflicts({
      corpus,
      facts: [
        fact({
          factId: '1',
          key: 'fee',
          value: 99,
          doc: 'a',
          state: 'conflicting',
          conflictsWith: ['2'],
        }),
        fact({
          factId: '2',
          key: 'fee',
          value: 12,
          doc: 'b',
          state: 'conflicting',
          conflictsWith: ['1'],
        }),
      ],
    })
    expect(out).toMatchObject({ caught: 0, falseAlarmRate: 1, winnerAccuracy: null })
  })
})

describe('corpusEntityTypes', () => {
  it('passes the registry rules an app type must', () => {
    expect(entityTypeIssues([{ owner: null, types: corpusEntityTypes() }])).toEqual([])
  })
})
