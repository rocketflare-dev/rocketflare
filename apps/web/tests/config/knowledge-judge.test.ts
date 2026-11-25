/**
 * The decision model's half of knowledge facts (D43), pure: `createKnowledgeJudge` over a scripted
 * engine — what it asks, the `JUDGE_MIN_PROBABILITY` threshold, unsure (`null`) versus unanswered
 * (`undefined`) — and `decideFactState` reading a judged pair. The database half (stored verdicts,
 * linking, `new`) is `tests/api/knowledge-extract.test.ts`.
 */
import type { DecisionRequest } from '@rocketflare/shared/ai/decisions'
import { describe, expect, it } from 'vitest'
import type { ResolvedDecisions } from '@/api/services/ai/resolve'
import {
  createKnowledgeJudge,
  type EntityQuestion,
  JUDGE_MIN_PROBABILITY,
  type ValueQuestion,
} from '@/api/services/knowledge/judge'
import { decideFactState, type HeldFact } from '@/api/services/knowledge/state'
import type { Database } from '@/db/client'

type Answers = Record<string, { choice: string; p: number }>

function engine(answer: (request: DecisionRequest) => Answers | Error) {
  const requests: DecisionRequest[] = []
  const resolved: ResolvedDecisions = {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    method: 'llm_self_report',
    source: 'fallback',
    client: {
      provider: 'anthropic',
      method: 'llm_self_report',
      async ask(request) {
        requests.push(request)
        const out = answer(request)
        if (out instanceof Error) throw out
        return {
          model: 'claude-haiku-5-5',
          usage: { inputTokens: 1, outputTokens: 1 },
          answers: Object.fromEntries(
            Object.entries(out).map(([id, a]) => [
              id,
              {
                type: 'choice',
                choice: a.choice,
                probabilities: { [a.choice]: a.p },
                confidence: a.p,
              },
            ])
          ),
        }
      },
    },
  }
  return { resolved, requests }
}

// Metering writes through `db`; a stand-in that throws is swallowed — a judgement never fails on it.
const db = {} as Database

const pair = (a: string, b: string): ValueQuestion => ({
  entity: { type: 'customer', label: 'Customer', name: 'Harbour View Dental' },
  key: 'primary_contact',
  a: { value: a, quote: a, document: 'one' },
  b: { value: b, quote: b, document: 'two' },
})

describe('createKnowledgeJudge — values', () => {
  it('acts on a confident same / more_specific, and answers null for different or unsure', async () => {
    const { resolved, requests } = engine(() => ({
      pair_0: { choice: 'same', p: 0.95 },
      pair_1: { choice: 'more_specific', p: 0.9 },
      pair_2: { choice: 'different', p: 0.99 },
      pair_3: { choice: 'same', p: JUDGE_MIN_PROBABILITY - 0.05 },
    }))
    const judge = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => resolved,
    })
    const out = await judge.values([
      pair('per call-out', 'per visit'),
      pair('Marcus', 'Marcus Bell'),
      pair('Marcus Bell', 'Sophie Tran'),
      pair('Mon', 'Tue'),
    ])
    expect(out.map(a => a?.answer ?? a)).toEqual(['same', 'compatible', null, null])
    expect(out[0]).toMatchObject({ method: 'llm_self_report', model: 'claude-haiku-5-5' })
    // One request, one choice question per pair, the passages in the state as written.
    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
      'pair_0',
      'pair_1',
      'pair_2',
      'pair_3',
    ])
    expect(JSON.stringify(requests[0]?.state)).toContain('per call-out')
  })

  it('a failed call or no engine at all answers undefined — nothing is decided, ask again later', async () => {
    const failing = engine(() => new Error('provider down'))
    const judge = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => failing.resolved,
    })
    expect(await judge.values([pair('a', 'b')])).toEqual([undefined])
    const none = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => null,
    })
    expect(await none.engine()).toBeNull()
    expect(await none.values([pair('a', 'b')])).toEqual([undefined])
  })
})

describe('createKnowledgeJudge — entities', () => {
  const question: EntityQuestion = {
    type: 'service',
    label: 'Service',
    mention: {
      names: ['Winter gritting (annual plan)'],
      facts: ['price_gbp = 1140'],
      quotes: ['| Winter gritting (annual plan) | £1,140 |'],
      document: 'Service catalogue',
    },
    candidates: [
      { id: 'e-1', name: 'Gritting call-out', aliases: [], facts: ['price_gbp = 85'] },
      {
        id: 'e-2',
        name: 'Car park and entrances gritting (annual plan, per site)',
        aliases: [],
        facts: ['price_gbp = 1140'],
      },
    ],
  }

  it('maps the chosen option back to the candidate id, or new', async () => {
    const picks = engine(() => ({ mention_0: { choice: 'known_1', p: 0.9 } }))
    const judge = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => picks.resolved,
    })
    expect((await judge.entities([question]))[0]?.answer).toBe('e-2')
    const asked = picks.requests[0]?.questions.mention_0 as
      | { criteria: Record<string, unknown> }
      | undefined
    const options = Object.keys(asked?.criteria ?? {})
    expect(options).toEqual(['known_0', 'known_1', 'new'])

    const fresh = engine(() => ({ mention_0: { choice: 'new', p: 0.85 } }))
    const judge2 = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => fresh.resolved,
    })
    expect((await judge2.entities([question]))[0]?.answer).toBe('new')
  })

  it('an unsure pick is null: the caller keeps its review item', async () => {
    const unsure = engine(() => ({ mention_0: { choice: 'known_1', p: 0.6 } }))
    const judge = createKnowledgeJudge({
      db,
      tenantId: 't',
      userId: null,
      resolve: async () => unsure.resolved,
    })
    expect(await judge.entities([question])).toEqual([null])
  })
})

describe('decideFactState with a judged pair', () => {
  const held = (over: Partial<HeldFact>): HeldFact => ({
    id: 'a',
    state: 'unconfirmed',
    valueKey: 's:marcusbell',
    validFrom: null,
    validTo: null,
    ...over,
  })
  const candidate = { valueKey: 's:marcus', confidence: 0.9, validFrom: null, validTo: null }

  it('same corroborates, compatible is neither, unknown conflicts', () => {
    expect(decideFactState(candidate, [held({})], () => 'same')).toMatchObject({
      state: 'accepted',
      confirms: ['a'],
      conflictsWith: [],
    })
    expect(decideFactState(candidate, [held({})], () => 'compatible')).toMatchObject({
      state: 'accepted',
      confirms: [],
      conflictsWith: [],
    })
    expect(decideFactState(candidate, [held({})], () => undefined)).toMatchObject({
      state: 'conflicting',
      conflictsWith: ['a'],
    })
    expect(decideFactState(candidate, [held({})]).state).toBe('conflicting')
  })
})
