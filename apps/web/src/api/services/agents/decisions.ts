/**
 * `ctx.decide` — typed questions an agent asks about a state, answered with probabilities by
 * the tenant's decisions engine (TypeSafe's Jev, or the chat-model fallback) and recorded in
 * `agent_run_decisions`.
 *
 * **Once per `(run_id, key)`, like `ctx.once` and `ctx.interrupt`.** A retried or resumed
 * `execute` re-enters `run()` from the top and reaches the same `ctx.decide(key, …)` again; the
 * recorded row is returned without a second call, so the run takes the same branch it took before
 * and the engine is billed once. The key is the agent's and must be stable across attempts.
 *
 * **A recorded key with DIFFERENT questions is a bug, and it throws.** Answers to one question set
 * returned for another would be silently wrong — the fingerprint (`questions_hash`) is compared on
 * every replay. A state that changed between attempts is allowed (a search may return different
 * hits); a question that changed is not.
 *
 * Two shapes on top of the raw call, because they are what an agent reaches for first:
 * - `sift` — the same yes/no of every item in ONE request (TypeSafe answers the questions in
 *   parallel); keeps the items at or above `threshold`.
 * - `pick` — one `choice` over the items plus `none`; the item, or null.
 */
import {
  type AgentRunDecision,
  type DecisionAnswer,
  type DecisionAnswers,
  type DecisionMethod,
  type DecisionQuestion,
  type DecisionRequest,
  decisionAnswerLabel,
  decisionRequestSchema,
} from '@rocketflare/shared/ai/decisions'
import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AgentRunDecisionRow, agentRunDecisions } from '../../../db/schema'
import { traceStep } from '../../observability/context'
import { decisionAttributes } from '../../observability/genai-attributes'
import { hashToken } from '../../utils/core/hash'
import type { ResolvedDecisions } from '../ai/resolve'
import type { RunMeter } from './budget'

/** Most items one `sift` asks about — TypeSafe's per-request question budget, with headroom. */
export const SIFT_MAX_ITEMS = 100
/** Most items one `pick` chooses between (TypeSafe allows 255 options; one is `none`). */
export const PICK_MAX_ITEMS = 254
/** The option `pick` adds for "none of these". */
export const PICK_NONE = 'none'

/** What `ctx.decide(...)` resolves to. */
export interface Decision {
  decisionId: string
  answers: DecisionAnswers
  provider: string
  method: DecisionMethod
  model: string
  /** True when this attempt read a recorded answer rather than asking. */
  replayed: boolean
}

export interface SiftOptions<T> {
  items: readonly T[]
  /** The yes/no asked of EVERY item — complete in itself; the item is `` `items[i]` `` in the state. */
  instructions: string | string[]
  criteria?: { true: string; false: string }
  /** Shown to the engine instead of the raw item (keep it small: the state is billed per token). */
  describe?: (item: T) => unknown
  /** Shared context every item is judged against (the question being researched, the customer…). */
  context?: unknown
  /** Keep an item when P(yes) ≥ this. Default 0.5 — the threshold is policy, so it is yours. */
  threshold?: number
}

export interface SiftResult<T> {
  kept: T[]
  /** P(yes) per item, in input order. */
  p: number[]
  decision: Decision
}

export interface PickOptions<T> {
  items: readonly T[]
  instructions: string | string[]
  /** A stable id per item (an option id: `[A-Za-z0-9_.-]{1,64}`); defaults to the index. */
  idOf?: (item: T, index: number) => string
  /** The description the engine reads for each item — it never sees the id. */
  describe: (item: T) => string
  /** What `none` means, in your words. */
  none?: string
  context?: unknown
}

export interface PickResult<T> {
  item: T | null
  /** The chosen option's probability (of `none` when nothing was picked). */
  p: number
  confidence: number
  decision: Decision
}

/** `ctx.decide` — callable, with the two shapes as properties. */
export interface AgentDecide {
  (key: string, request: DecisionRequest): Promise<Decision>
  sift<T>(key: string, options: SiftOptions<T>): Promise<SiftResult<T>>
  pick<T>(key: string, options: PickOptions<T>): Promise<PickResult<T>>
}

export interface DecideDeps {
  db: Database
  tenantId: string
  runId: string
  userId: string | null
  agentKey: string
  /** Resolved on first use, not per attempt — an agent that never decides never resolves. */
  resolve: () => Promise<ResolvedDecisions>
  /**
   * The run's meter: checked before every FRESH ask (a replayed answer costs nothing) and
   * written after it — one `ai_usage` row, `agent:<key>:decide`, carrying the run id.
   */
  meter: RunMeter
  /** Thin `decision` event into the run's log. */
  emit: (data: unknown) => Promise<void>
}

export class DecisionKeyConflictError extends Error {
  constructor(key: string) {
    super(
      `ctx.decide("${key}") was called with different questions than the answer recorded for this run — a decision key must name ONE question set`
    )
    this.name = 'DecisionKeyConflictError'
  }
}

export function createDecide(deps: DecideDeps): AgentDecide {
  let resolved: Promise<ResolvedDecisions> | undefined
  const engine = () => {
    resolved ??= deps.resolve()
    return resolved
  }

  return decideWithShapes(async (key: string, request: DecisionRequest): Promise<Decision> => {
    const parsed = decisionRequestSchema.parse(request)
    const hash = await questionsHash(parsed.questions)
    const questions = Object.keys(parsed.questions).length

    const recorded = await findDecision(deps.db, deps.tenantId, deps.runId, key)
    if (recorded) {
      if (recorded.questionsHash !== hash) throw new DecisionKeyConflictError(key)
      return traceStep(
        {
          name: `decide ${key}`,
          kind: 'span',
          attributes: decisionAttributes({
            key,
            method: recorded.method,
            questions,
            questionsHash: hash,
            replayed: true,
          }),
        },
        async () => toDecision(recorded, true)
      )
    }

    const { client, model, provider, method } = await engine()
    await deps.meter.check()
    return traceStep(
      {
        name: `decide ${key}`,
        kind: 'llm',
        input: parsed,
        attributes: decisionAttributes({
          key,
          method,
          provider,
          model,
          questions,
          questionsHash: hash,
        }),
      },
      async () => {
        const startedAt = Date.now()
        const result = await client.ask(parsed, { model })
        const latencyMs = Date.now() - startedAt
        const row = await insertDecision(deps.db, {
          tenantId: deps.tenantId,
          runId: deps.runId,
          key,
          provider,
          method,
          model: result.model,
          request: parsed,
          answers: result.answers,
          usage: result.usage,
          questionsHash: hash,
          latencyMs,
        })
        await deps.meter.record({
          feature: `agent:${deps.agentKey}:decide`,
          provider,
          model: result.model,
          usage: result.usage,
        })
        // The event lists answers in the order the questions were ASKED: jsonb keeps object keys in
        // its own order (shortest first), so the row cannot be the source for it.
        await deps.emit(eventData(row, Object.keys(parsed.questions), result.answers))
        return toDecision(row, false)
      },
      decision => ({
        output: summarise(decision.answers),
        attributes: { 'rocketflare.decision.min_confidence': minConfidence(decision.answers) },
      })
    )
  })
}

/**
 * `sift` and `pick` on top of any raw decide — the runtime's, or replay's, which serves
 * recorded answers. One implementation of the shapes is what lets a replay rebuild the SAME
 * request, and so the same `questions_hash`, that the run asked.
 */
export function decideWithShapes(
  raw: (key: string, request: DecisionRequest) => Promise<Decision>
): AgentDecide {
  const decide = raw as AgentDecide

  decide.sift = async <T>(key: string, options: SiftOptions<T>): Promise<SiftResult<T>> => {
    const request = siftRequest(options)
    const decision = await decide(key, request)
    const threshold = options.threshold ?? 0.5
    const p = options.items.map((_item, i) => decision.answers[siftId(i)]?.noul ?? 0)
    return { kept: options.items.filter((_item, i) => (p[i] ?? 0) >= threshold), p, decision }
  }

  decide.pick = async <T>(key: string, options: PickOptions<T>): Promise<PickResult<T>> => {
    const { request, ids } = pickRequest(options)
    const decision = await decide(key, request)
    const answer = decision.answers.pick as DecisionAnswer
    const chosen = answer.choice ?? PICK_NONE
    const index = ids.indexOf(chosen)
    return {
      item: index >= 0 ? (options.items[index] as T) : null,
      p: answer.probabilities?.[chosen] ?? 0,
      confidence: answer.confidence,
      decision,
    }
  }

  return decide
}

// ---- request builders (pure, exported for tests) ---------------------------------------------

const siftId = (i: number) => `item_${i}`

export function siftRequest<T>(options: SiftOptions<T>): DecisionRequest {
  if (options.items.length === 0) throw new Error('sift needs at least one item')
  if (options.items.length > SIFT_MAX_ITEMS) {
    throw new Error(`sift asks about at most ${SIFT_MAX_ITEMS} items per decision`)
  }
  const describe = options.describe ?? ((item: T) => item)
  const instructions = Array.isArray(options.instructions)
    ? options.instructions.join(' ')
    : options.instructions
  const questions: Record<string, DecisionQuestion> = {}
  options.items.forEach((_item, i) => {
    questions[siftId(i)] = {
      type: 'noul',
      instructions: `About \`items[${i}]\`: ${instructions}`,
      ...(options.criteria && { criteria: options.criteria }),
    }
  })
  return {
    state: {
      ...(options.context !== undefined && { context: options.context }),
      items: options.items.map(describe),
    },
    questions,
  }
}

export function pickRequest<T>(options: PickOptions<T>): {
  request: DecisionRequest
  ids: string[]
} {
  if (options.items.length === 0) throw new Error('pick needs at least one item')
  if (options.items.length > PICK_MAX_ITEMS) {
    throw new Error(`pick chooses between at most ${PICK_MAX_ITEMS} items`)
  }
  const ids = options.items.map((item, i) => options.idOf?.(item, i) ?? `item_${i}`)
  if (ids.includes(PICK_NONE) || new Set(ids).size !== ids.length) {
    throw new Error(`pick ids must be unique and must not be "${PICK_NONE}"`)
  }
  const criteria: Record<string, string> = {}
  options.items.forEach((item, i) => {
    criteria[ids[i] as string] = options.describe(item)
  })
  criteria[PICK_NONE] = options.none ?? 'None of the other options fits'
  return {
    ids,
    request: {
      state: options.context ?? {},
      questions: { pick: { type: 'choice', instructions: options.instructions, criteria } },
    },
  }
}

// ---- persistence -----------------------------------------------------------------------------

export async function findDecision(
  db: Database,
  tenantId: string,
  runId: string,
  key: string
): Promise<AgentRunDecisionRow | undefined> {
  const [row] = await db
    .select()
    .from(agentRunDecisions)
    .where(
      and(
        eq(agentRunDecisions.tenantId, tenantId),
        eq(agentRunDecisions.runId, runId),
        eq(agentRunDecisions.key, key)
      )
    )
    .limit(1)
  return row
}

/** Insert, or — when a concurrent attempt won the race — the row that won. */
async function insertDecision(
  db: Database,
  values: typeof agentRunDecisions.$inferInsert
): Promise<AgentRunDecisionRow> {
  const [inserted] = await db
    .insert(agentRunDecisions)
    .values(values)
    .onConflictDoNothing({ target: [agentRunDecisions.runId, agentRunDecisions.key] })
    .returning()
  if (inserted) return inserted
  const winner = await findDecision(db, values.tenantId, values.runId, values.key)
  if (!winner) throw new Error(`agent_run_decisions: lost a race on "${values.key}" to nobody`)
  return winner
}

export async function listDecisions(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunDecision[]> {
  const rows = await db
    .select()
    .from(agentRunDecisions)
    .where(and(eq(agentRunDecisions.tenantId, tenantId), eq(agentRunDecisions.runId, runId)))
    .orderBy(asc(agentRunDecisions.createdAt))
  return rows.map(toAgentRunDecision)
}

export function toAgentRunDecision(row: AgentRunDecisionRow): AgentRunDecision {
  return {
    id: row.id,
    runId: row.runId,
    key: row.key,
    provider: row.provider,
    method: row.method,
    model: row.model,
    request: row.request,
    answers: row.answers,
    questionsHash: row.questionsHash,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  }
}

/**
 * The policy fingerprint: sha256 over the questions with object keys sorted, 12 hex chars (the
 * eval kit's prompt-hash convention). The state is deliberately excluded — every case judged under
 * one rubric shares a hash.
 */
export async function questionsHash(questions: DecisionRequest['questions']): Promise<string> {
  return (await hashToken(stableStringify(questions))).slice(0, 12)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function toDecision(row: AgentRunDecisionRow, replayed: boolean): Decision {
  return {
    decisionId: row.id,
    answers: row.answers,
    provider: row.provider,
    method: row.method,
    model: row.model,
    replayed,
  }
}

function eventData(row: AgentRunDecisionRow, order: string[], answers: DecisionAnswers) {
  return {
    decisionId: row.id,
    key: row.key,
    provider: row.provider,
    method: row.method,
    answers: order.flatMap(id => {
      const answer = answers[id]
      return answer
        ? [
            {
              id,
              type: answer.type,
              answer: decisionAnswerLabel(answer),
              confidence: answer.confidence,
            },
          ]
        : []
    }),
  }
}

function minConfidence(answers: DecisionAnswers): number {
  return Math.min(...Object.values(answers).map(a => a.confidence))
}

function summarise(answers: DecisionAnswers): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [
      id,
      `${decisionAnswerLabel(a)} (${a.confidence.toFixed(2)})`,
    ])
  )
}
