/**
 * TypeSafe's System One API (Jev) behind the `DecisionClient` seam. Plain `fetch`, no SDK:
 * `@typesafe-ai/sdk` targets Node ≥ 20 and the Worker needs nothing it adds.
 *
 *   POST {baseUrl}/v1/systemone   Authorization: Bearer <key>
 *   { model, state, questions }  →  { model, answers: { [id]: { type, noul|choice|score, probabilities?, confidence? } }, usage }
 *
 * The request is our `DecisionRequest` verbatim — the contract was written in TypeSafe's
 * vocabulary so this adapter maps nothing. What it does own:
 * - **Errors** become `AiError` by status (`codeForStatus`: 401/403 auth, 422 invalid_request,
 *   429/529 rate_limit, 5xx unavailable), so the agent runtime's retry classification applies.
 * - **429/529 retry here first**, briefly, with backoff (TypeSafe's guidance); a run-level retry is
 *   the second line, not the first.
 * - **A `noul` answer carries no confidence** (by design: one probability says it all), so it is
 *   derived here with TypeSafe's own `|2p − 1|`; every answer leaves this module complete.
 */
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionRequest,
} from '@rocketflare/shared/ai/decisions'
import { choiceConfidence, noulConfidence, scoreConfidence } from '@rocketflare/shared/ai/decisions'
import { z } from 'zod'
import type { FetchLike } from '../client'
import { AiError, codeForStatus, normalizeAiError, redactSecrets } from '../errors'
import type { DecisionClient, DecisionResult } from './types'

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai'
/** A decision is a ~150 ms call; anything near this is an outage, not a slow answer. */
export const TYPESAFE_TIMEOUT_MS = 30_000
/** Waits before each retry of a 429/529. Two retries, then the error stands. */
export const TYPESAFE_RETRY_DELAYS_MS = [250, 1_000] as const

export interface TypesafeClientOptions {
  apiKey: string
  baseUrl?: string | null
  fetch?: FetchLike
  /** Injected for tests so a retry does not cost real time. */
  sleep?: (ms: number) => Promise<void>
}

const probability = z.number().min(0).max(1)
const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z
      .object({
        type: z.enum(['noul', 'choice', 'score']),
        noul: probability.optional(),
        choice: z.string().optional(),
        score: z.number().optional(),
        probabilities: z.record(z.string(), z.number()).optional(),
        confidence: probability.optional(),
      })
      .passthrough()
  ),
  usage: z
    .object({
      input_tokens: z.number().int().optional(),
      output_tokens: z.number().int().optional(),
    })
    .partial()
    .optional(),
})

export function createTypesafeClient(options: TypesafeClientOptions): DecisionClient {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const url = `${(options.baseUrl || TYPESAFE_BASE_URL).replace(/\/+$/, '')}/v1/systemone`

  async function post(body: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal,
      })
      const retryable = res.status === 429 || res.status === 529
      const delay = TYPESAFE_RETRY_DELAYS_MS[attempt]
      if (!retryable || delay === undefined) return res
      await res.body?.cancel()
      await sleep(delay)
    }
  }

  return {
    provider: 'typesafe',
    method: 'typesafe',
    async ask(request, { model, signal }): Promise<DecisionResult> {
      const body = JSON.stringify({ model, state: request.state, questions: request.questions })
      let res: Response
      try {
        res = await post(body, signal ?? AbortSignal.timeout(TYPESAFE_TIMEOUT_MS))
      } catch (err) {
        throw normalizeAiError(err, 'typesafe')
      }
      if (!res.ok) throw await errorFrom(res)
      let json: unknown
      try {
        json = await res.json()
      } catch (err) {
        throw new AiError(
          'unknown',
          'typesafe',
          'TypeSafe returned a body that is not JSON',
          res.status,
          {
            cause: err,
          }
        )
      }
      const parsed = responseSchema.safeParse(json)
      if (!parsed.success) {
        throw new AiError(
          'unknown',
          'typesafe',
          'TypeSafe returned an unexpected response shape',
          res.status
        )
      }
      return {
        answers: completeAnswers(request, parsed.data.answers),
        usage: {
          inputTokens: parsed.data.usage?.input_tokens ?? 0,
          outputTokens: parsed.data.usage?.output_tokens ?? 0,
        },
        model: parsed.data.model ?? model,
      }
    },
  }
}

type RawAnswer = z.infer<typeof responseSchema>['answers'][string]

/** Every question answered, every answer with a confidence — or an `AiError`, never a partial set. */
export function completeAnswers(
  request: DecisionRequest,
  raw: Record<string, RawAnswer>
): DecisionAnswers {
  const out: DecisionAnswers = {}
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = raw[id]
    if (!answer || answer.type !== question.type) {
      throw new AiError(
        'unknown',
        'typesafe',
        `TypeSafe returned no ${question.type} answer for "${id}"`
      )
    }
    out[id] = withConfidence(answer)
  }
  return out
}

function withConfidence(answer: RawAnswer): DecisionAnswer {
  const probabilities = answer.probabilities
  const values = probabilities ? Object.values(probabilities) : []
  const confidence =
    answer.confidence ??
    (answer.type === 'noul'
      ? noulConfidence(answer.noul ?? 0.5)
      : answer.type === 'choice'
        ? choiceConfidence(values)
        : scoreConfidence(
            Object.entries(probabilities ?? {})
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, p]) => p)
          ))
  return {
    type: answer.type,
    ...(answer.noul !== undefined && { noul: answer.noul }),
    ...(answer.choice !== undefined && { choice: answer.choice }),
    ...(answer.score !== undefined && { score: answer.score }),
    ...(probabilities && { probabilities }),
    confidence,
  }
}

/** The status decides the code; the body contributes at most a redacted sentence. */
async function errorFrom(res: Response): Promise<AiError> {
  let detail = ''
  try {
    const text = await res.text()
    detail = redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 160)
  } catch {
    // the status is enough
  }
  const message = `TypeSafe answered ${res.status}${detail ? `: ${detail}` : ''}`
  return new AiError(codeForStatus(res.status), 'typesafe', message, res.status)
}
