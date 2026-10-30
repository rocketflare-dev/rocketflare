/**
 * The decisions fallback: a chat model answers the same typed questions Jev does, through ONE
 * forced tool call whose schema has a field per question — `p_yes` for a noul, a probability per
 * option for a choice, one per level for a score. The model's numbers are normalised here and the
 * confidence is computed with TypeSafe's published formulas, so the two engines read on one scale.
 *
 * **These probabilities are self-reported, not calibrated.** A chat model asked "how sure?" answers
 * with a number, not a frequency; every decision this engine makes is recorded as
 * `llm_self_report` so an eval, a reviewer or a threshold can tell the difference. It exists so
 * `ctx.decide` works with zero TypeSafe configuration, not to stand in for it.
 *
 * Property names: a question id becomes a tool-schema property and an option id a nested one.
 * Both use `[A-Za-z0-9_.-]` (the contract enforces it), which every provider accepts; score levels
 * are `level_<i>` because some providers reject a bare-digit property name.
 */

import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionQuestion,
  DecisionRequest,
} from '@rocketflare/shared/ai/decisions'
import { choiceConfidence, noulConfidence, scoreConfidence } from '@rocketflare/shared/ai/decisions'
import { z } from 'zod'
import { callStructuredTool } from '../agent-loop'
import type { ChatClient, SystemPrompt } from '../types'
import type { DecisionClient, DecisionResult } from './types'

export const DECIDE_TOOL = 'submit_judgments'
/** Each answer is a handful of numbers; this is room for 100 questions, not for prose. */
const DECIDE_MAX_TOKENS = 4_096

export interface LlmDecisionClientOptions {
  chat: ChatClient
  /** The `agent-decide` prompt, resolved by the caller (tenant overrides apply). */
  system: SystemPrompt
}

const p = z.number().min(0).max(1)
const levelKey = (i: number) => `level_${i}`

/** The tool input schema: one property per question, shaped by its type. */
export function judgmentSchema(questions: DecisionRequest['questions']) {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      shape[id] = z.object({ p_yes: p.describe('Probability the answer is yes') })
    } else if (q.type === 'choice') {
      const options: Record<string, z.ZodTypeAny> = {}
      for (const option of Object.keys(q.criteria)) options[option] = p
      shape[id] = z.object(options).describe('Probability of each option; they should sum to 1')
    } else {
      const levels: Record<string, z.ZodTypeAny> = {}
      q.criteria.forEach((_c, i) => {
        levels[levelKey(i)] = p
      })
      shape[id] = z.object(levels).describe('Probability of each level; they should sum to 1')
    }
  }
  return z.object(shape)
}

/** The user turn: the state, then each question with its criteria, in the shape the schema asks for. */
export function renderDecisionPrompt(request: DecisionRequest): string {
  const lines = [
    '<state>',
    typeof request.state === 'string' ? request.state : JSON.stringify(request.state, null, 2),
    '</state>',
    '',
    'Answer every question below about the state, independently of each other.',
    '',
  ]
  for (const [id, q] of Object.entries(request.questions)) {
    lines.push(`## ${id} (${q.type})`, text(q.instructions))
    if (q.type === 'noul' && q.criteria) {
      lines.push(`- yes: ${text(q.criteria.true)}`, `- no: ${text(q.criteria.false)}`)
    } else if (q.type === 'choice') {
      for (const [option, c] of Object.entries(q.criteria)) {
        lines.push(`- ${option}: ${c === null ? option : text(c)}`)
      }
    } else if (q.type === 'score') {
      q.criteria.forEach((c, i) => {
        lines.push(`- ${levelKey(i)}: ${text(c)}`)
      })
    }
    lines.push('')
  }
  lines.push(`Call ${DECIDE_TOOL} with a probability for every option of every question.`)
  return lines.join('\n')
}

export function createLlmDecisionClient(options: LlmDecisionClientOptions): DecisionClient {
  return {
    provider: options.chat.provider,
    method: 'llm_self_report',
    async ask(request, { model, signal }): Promise<DecisionResult> {
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
      const raw = await callStructuredTool(options.chat, {
        model,
        system: options.system,
        messages: [{ role: 'user', content: renderDecisionPrompt(request) }],
        tool: {
          name: DECIDE_TOOL,
          description: 'Submit a probability for every option of every question.',
          schema: judgmentSchema(request.questions),
        },
        maxTokens: DECIDE_MAX_TOKENS,
        signal,
        onUsage: u => {
          usage = u
        },
      })
      const answers: DecisionAnswers = {}
      for (const [id, q] of Object.entries(request.questions)) {
        answers[id] = toAnswer(q, (raw as Record<string, Record<string, number>>)[id] ?? {})
      }
      return { answers, usage, model }
    },
  }
}

/** Normalise one question's numbers into the contract's answer shape. Exported for tests. */
export function toAnswer(q: DecisionQuestion, values: Record<string, number>): DecisionAnswer {
  if (q.type === 'noul') {
    const yes = clamp01(values.p_yes ?? 0.5)
    return { type: 'noul', noul: yes, confidence: noulConfidence(yes) }
  }
  const keys =
    q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_c, i) => levelKey(i))
  const normalised = normalise(keys.map(k => values[k] ?? 0))
  if (q.type === 'choice') {
    const top = normalised.indexOf(Math.max(...normalised))
    return {
      type: 'choice',
      choice: keys[top],
      probabilities: Object.fromEntries(keys.map((k, i) => [k, normalised[i] ?? 0])),
      confidence: choiceConfidence(normalised),
    }
  }
  return {
    type: 'score',
    score: normalised.reduce((sum, pi, i) => sum + pi * i, 0),
    probabilities: Object.fromEntries(normalised.map((pi, i) => [String(i), pi])),
    confidence: scoreConfidence(normalised),
  }
}

/** Scale to sum 1; an all-zero answer is an even spread (the model said nothing, so nothing is known). */
function normalise(values: number[]): number[] {
  const clean = values.map(clamp01)
  const sum = clean.reduce((a, b) => a + b, 0)
  return sum > 0 ? clean.map(v => v / sum) : clean.map(() => 1 / clean.length)
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' ')
  return JSON.stringify(value)
}
