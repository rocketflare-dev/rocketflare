/**
 * Decisions, the pure half: the shared contract and TypeSafe's confidence definitions, the
 * TypeSafe client against an injected `fetch` (request shape, error mapping, the 429/529 retry,
 * the derived noul confidence, redaction), the LLM fallback's schema/normalisation, and the
 * `sift` / `pick` request builders and the questions fingerprint. No database, no network.
 */
import {
  choiceConfidence,
  decisionAnswerLabel,
  decisionRequestSchema,
  noulConfidence,
  scoreConfidence,
} from '@rocketflare/shared/ai/decisions'
import { describe, expect, it, vi } from 'vitest'
import { PICK_NONE, pickRequest, questionsHash, siftRequest } from '@/api/services/agents/decisions'
import {
  createLlmDecisionClient,
  judgmentSchema,
  renderDecisionPrompt,
  toAnswer,
} from '@/api/services/ai/decisions/llm'
import { createTypesafeClient, TYPESAFE_BASE_URL } from '@/api/services/ai/decisions/typesafe'
import { AiError } from '@/api/services/ai/errors'
import { FakeChatClient } from '../helpers/ai'

const noul = { type: 'noul' as const, instructions: 'Is it a greeting?' }
const choice = {
  type: 'choice' as const,
  instructions: 'Which team?',
  criteria: { returns: 'Exchanges', shipping: 'Delivery', billing: 'Charges' },
}
const score = {
  type: 'score' as const,
  instructions: 'How severe?',
  criteria: ['Cosmetic', 'Degraded with a workaround', 'Blocking'],
}

describe('confidence (TypeSafe definitions)', () => {
  it('noul is the distance from a coin toss', () => {
    expect(noulConfidence(0.5)).toBe(0)
    expect(noulConfidence(0.93)).toBeCloseTo(0.86)
    expect(noulConfidence(0.07)).toBeCloseTo(0.86)
  })

  it('choice counts only the top option, against an even spread', () => {
    expect(choiceConfidence([0, 1, 0])).toBe(1)
    expect(choiceConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0)
    expect(choiceConfidence([0.6, 0.4])).toBeCloseTo(0.2)
  })

  it('score rewards a single peak and penalises distant levels more than adjacent ones', () => {
    expect(scoreConfidence([0, 1, 0])).toBe(1)
    const adjacent = scoreConfidence([0, 0.6, 0.4])
    const distant = scoreConfidence([0.4, 0.6, 0])
    expect(adjacent).toBeGreaterThan(0)
    expect(scoreConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0)
    expect(adjacent).toBeCloseTo(distant)
    expect(scoreConfidence([0.4, 0, 0.6])).toBeLessThan(scoreConfidence([0, 0.4, 0.6]))
  })

  it('labels an answer the way a timeline row and an eval expectation compare it', () => {
    expect(decisionAnswerLabel({ type: 'noul', noul: 0.7, confidence: 0.4 })).toBe('yes')
    expect(decisionAnswerLabel({ type: 'noul', noul: 0.2, confidence: 0.6 })).toBe('no')
    expect(decisionAnswerLabel({ type: 'choice', choice: 'returns', confidence: 1 })).toBe(
      'returns'
    )
    expect(decisionAnswerLabel({ type: 'score', score: 1.43, confidence: 0.35 })).toBe('1')
  })
})

describe('decisionRequestSchema', () => {
  it('accepts the three shapes and refuses ids a provider would reject', () => {
    expect(
      decisionRequestSchema.safeParse({ state: 'x', questions: { noul, choice, score } }).success
    ).toBe(true)
    expect(decisionRequestSchema.safeParse({ state: 'x', questions: {} }).success).toBe(false)
    expect(
      decisionRequestSchema.safeParse({ state: 'x', questions: { 'has space': noul } }).success
    ).toBe(false)
    expect(
      decisionRequestSchema.safeParse({
        state: 'x',
        questions: { c: { ...choice, criteria: { only: 'one' } } },
      }).success
    ).toBe(false)
    expect(
      decisionRequestSchema.safeParse({
        state: 'x',
        questions: { s: { ...score, criteria: ['one'] } },
      }).success
    ).toBe(false)
  })
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('TypeSafe client', () => {
  const request = { state: { text: 'ping' }, questions: { greeting: noul, team: choice } }
  const answers = {
    greeting: { type: 'noul', noul: 0.93 },
    team: {
      type: 'choice',
      choice: 'returns',
      confidence: 1,
      probabilities: { returns: 1, shipping: 0, billing: 0 },
    },
  }

  it('posts the request verbatim with a bearer token and completes every answer', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 328, output_tokens: 34 },
      })
    )
    const client = createTypesafeClient({ apiKey: 'ts-secret', fetch: fetchSpy as typeof fetch })
    const result = await client.ask(request, { model: 'jev-latest' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${TYPESAFE_BASE_URL}/v1/systemone`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ts-secret')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'jev-latest',
      state: request.state,
      questions: request.questions,
    })
    expect(result.model).toBe('jev-1.13.0')
    expect(result.usage).toEqual({ inputTokens: 328, outputTokens: 34 })
    // A noul carries no confidence on the wire; it is derived with TypeSafe's own |2p − 1|.
    expect(result.answers.greeting?.confidence).toBeCloseTo(0.86)
    expect(result.answers.team).toMatchObject({ choice: 'returns', confidence: 1 })
  })

  it('maps statuses to AiError codes and never echoes the key', async () => {
    const cases: [number, string][] = [
      [401, 'auth'],
      [422, 'invalid_request'],
      [500, 'unavailable'],
    ]
    for (const [status, code] of cases) {
      const client = createTypesafeClient({
        apiKey: 'ts-secret-key',
        fetch: (async () =>
          new Response('Bearer ts-secret-key rejected', { status })) as unknown as typeof fetch,
      })
      const err = await client.ask(request, { model: 'jev-latest' }).catch(e => e)
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe(code)
      expect((err as AiError).message).not.toContain('ts-secret-key')
    }
  })

  it('retries 429/529 with backoff, then lets the error stand', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    const flaky = createTypesafeClient({
      apiKey: 'k',
      sleep,
      fetch: (async () =>
        ++calls === 1
          ? new Response('', { status: 529 })
          : jsonResponse({ answers })) as unknown as typeof fetch,
    })
    expect((await flaky.ask(request, { model: 'jev-latest' })).answers.team?.choice).toBe('returns')
    expect(sleep).toHaveBeenCalledTimes(1)

    const always = createTypesafeClient({
      apiKey: 'k',
      sleep: async () => {},
      fetch: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
    })
    const err = await always.ask(request, { model: 'jev-latest' }).catch(e => e)
    expect((err as AiError).code).toBe('rate_limit')
  })

  it('refuses a response missing an asked question rather than returning a partial set', async () => {
    const client = createTypesafeClient({
      apiKey: 'k',
      fetch: (async () =>
        jsonResponse({ answers: { greeting: answers.greeting } })) as unknown as typeof fetch,
    })
    await expect(client.ask(request, { model: 'jev-latest' })).rejects.toBeInstanceOf(AiError)
  })
})

describe('LLM fallback', () => {
  it('builds one property per question, shaped by its type', () => {
    const schema = judgmentSchema({ greeting: noul, team: choice, severity: score })
    expect(
      schema.safeParse({
        greeting: { p_yes: 0.9 },
        team: { returns: 0.8, shipping: 0.1, billing: 0.1 },
        severity: { level_0: 0, level_1: 0.6, level_2: 0.4 },
      }).success
    ).toBe(true)
    expect(schema.safeParse({ greeting: { p_yes: 2 } }).success).toBe(false)
    const prompt = renderDecisionPrompt({ state: 'hello', questions: { team: choice } })
    expect(prompt).toContain('- returns: Exchanges')
    expect(prompt).toContain('<state>')
  })

  it('normalises the numbers and scores confidence on the same scale as Jev', () => {
    expect(toAnswer(choice, { returns: 2, shipping: 2, billing: 0 })).toMatchObject({
      choice: 'returns',
      probabilities: { returns: 0.5, shipping: 0.5, billing: 0 },
    })
    // Nothing said = nothing known: an even spread, zero confidence.
    expect(toAnswer(choice, {}).confidence).toBeCloseTo(0)
    expect(toAnswer(score, { level_2: 1 })).toMatchObject({ score: 2, confidence: 1 })
    expect(toAnswer(noul, { p_yes: 0.75 })).toMatchObject({ noul: 0.75, confidence: 0.5 })
  })

  it('answers through one forced tool call and reports itself uncalibrated', async () => {
    const chat = new FakeChatClient([
      {
        toolUses: [
          {
            name: 'submit_judgments',
            input: { greeting: { p_yes: 0.9 }, team: { returns: 1, shipping: 0, billing: 0 } },
          },
        ],
        usage: { inputTokens: 50, outputTokens: 20 },
      },
    ])
    const client = createLlmDecisionClient({ chat, system: 'judge' })
    expect(client.method).toBe('llm_self_report')
    const result = await client.ask(
      { state: 'hi', questions: { greeting: noul, team: choice } },
      { model: 'fake' }
    )
    expect(result.answers.greeting?.noul).toBe(0.9)
    expect(result.answers.team?.choice).toBe('returns')
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20 })
    expect(chat.calls).toHaveLength(1)
  })
})

describe('sift / pick request builders', () => {
  it('sift asks the same yes/no of every item, pointing each question at its item', () => {
    const request = siftRequest({
      items: ['a', 'b'],
      context: { question: 'q' },
      instructions: 'Is it relevant?',
    })
    expect(request.state).toEqual({ context: { question: 'q' }, items: ['a', 'b'] })
    expect(Object.keys(request.questions)).toEqual(['item_0', 'item_1'])
    expect(request.questions.item_1).toMatchObject({ type: 'noul' })
    expect(JSON.stringify(request.questions.item_1)).toContain('`items[1]`')
    expect(() => siftRequest({ items: [], instructions: 'x' })).toThrow()
  })

  it('pick is one choice over the items plus none, with unique ids', () => {
    const { request, ids } = pickRequest({
      items: [{ id: 'x' }, { id: 'y' }],
      idOf: item => item.id,
      describe: item => `record ${item.id}`,
      instructions: 'Which is our customer?',
    })
    expect(ids).toEqual(['x', 'y'])
    expect(request.questions.pick).toMatchObject({
      type: 'choice',
      criteria: { x: 'record x', y: 'record y', [PICK_NONE]: expect.any(String) },
    })
    expect(() =>
      pickRequest({ items: [1, 2], idOf: () => 'same', describe: String, instructions: 'x' })
    ).toThrow()
  })

  it('fingerprints the questions, not the state, independent of key order', async () => {
    const a = await questionsHash({ team: choice, greeting: noul })
    const b = await questionsHash({ greeting: noul, team: { ...choice } })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(await questionsHash({ greeting: { ...noul, instructions: 'Other?' } })).not.toBe(a)
  })
})
