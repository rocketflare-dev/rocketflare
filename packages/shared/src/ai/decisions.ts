/**
 * Decisions: typed questions an agent asks about a structured state, answered with a
 * probability rather than prose. The vocabulary is TypeSafe's System One API (`noul` = yes/no,
 * `choice` = one of named options, `score` = a position on ordered levels) so the `typesafe`
 * provider is a 1:1 mapping; the LLM fallback answers the same shapes.
 *
 * The rule the shapes encode: **a question decides what a thing IS; code decides what follows.**
 * An answer carries its distribution and a `confidence`, so the threshold that turns a 0.44 into
 * "escalate" is a number in the agent's code, not a mood in a prompt.
 *
 * Confidence uses TypeSafe's published formulas (`decisionConfidence`) for every engine, so a
 * number from the LLM fallback reads on the same scale as Jev's — but it is NOT calibrated, and
 * `method` says so on every recorded decision.
 *
 * Imports zod and siblings only.
 */
import { z } from 'zod'

/** Instructions or one criterion: a sentence, a list of them, or a structured description. */
const textishSchema = z.union([
  z.string().min(1).max(4_000),
  z.array(z.string().max(4_000)).max(50),
])
const criterionSchema = z.union([textishSchema, z.null(), z.record(z.string(), z.unknown())])

/** Most options a `choice` may carry (TypeSafe's limit). */
export const DECISION_MAX_OPTIONS = 255
/** Score levels: TypeSafe accepts 2–10. */
export const DECISION_SCORE_LEVELS = { min: 2, max: 10 } as const
/** Most questions one decision may ask. A sift over more items is split by the caller. */
export const DECISION_MAX_QUESTIONS = 100
/** Option ids are for code; keep them short identifiers so every engine can echo them back. */
const optionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'ids are 1-64 chars of [A-Za-z0-9_.-]')

export const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: textishSchema,
  criteria: z.object({ true: criterionSchema, false: criterionSchema }).optional(),
})
export const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: textishSchema,
  /** option id → what it means. The id is never shown to the model: the description must stand alone. */
  criteria: z
    .record(optionIdSchema, criterionSchema)
    .refine(c => Object.keys(c).length >= 2, 'a choice needs at least two options')
    .refine(
      c => Object.keys(c).length <= DECISION_MAX_OPTIONS,
      `a choice has at most ${DECISION_MAX_OPTIONS} options`
    ),
})
export const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: textishSchema,
  /** Level descriptions, lowest first. Each must describe a concrete situation on its own. */
  criteria: z.array(textishSchema).min(DECISION_SCORE_LEVELS.min).max(DECISION_SCORE_LEVELS.max),
})

export const decisionQuestionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
])
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>
export type DecisionQuestionType = DecisionQuestion['type']

/** Question ids are code identifiers too — the same alphabet as option ids. */
export const decisionQuestionIdSchema = optionIdSchema

/**
 * One decision = one request: a state and independent questions over it. Questions in the same
 * request cannot see each other's answers; a question that depends on another's answer is a
 * second decision.
 */
export const decisionRequestSchema = z.object({
  state: z.unknown(),
  questions: z
    .record(decisionQuestionIdSchema, decisionQuestionSchema)
    .refine(q => Object.keys(q).length >= 1, 'ask at least one question')
    .refine(
      q => Object.keys(q).length <= DECISION_MAX_QUESTIONS,
      `at most ${DECISION_MAX_QUESTIONS} questions per decision`
    ),
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

const probabilitySchema = z.number().min(0).max(1)

/**
 * One answer. Exactly the field for its `type` is set:
 * - `noul`: `noul` = P(yes); confidence `|2p − 1|`.
 * - `choice`: `choice` = the most probable option; `probabilities` over every option id.
 * - `score`: `score` = probability-weighted level (0 … levels−1, fractional); `probabilities`
 *   keyed by the level index as a string.
 */
export const decisionAnswerSchema = z.object({
  type: z.enum(['noul', 'choice', 'score']),
  noul: probabilitySchema.optional(),
  choice: z.string().optional(),
  score: z.number().min(0).optional(),
  probabilities: z.record(z.string(), probabilitySchema).optional(),
  confidence: probabilitySchema,
})
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>
export type DecisionAnswers = Record<string, DecisionAnswer>

/**
 * How the probabilities were produced. `typesafe` = Jev, trained for calibration;
 * `llm_self_report` = a chat model asked for its own distribution — useful, NOT calibrated.
 */
export const DECISION_METHODS = ['typesafe', 'llm_self_report'] as const
export const decisionMethodSchema = z.enum(DECISION_METHODS)
export type DecisionMethod = z.infer<typeof decisionMethodSchema>

/** One row of `agent_run_decisions` as the API returns it. */
export const agentRunDecisionSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  key: z.string(),
  provider: z.string(),
  method: decisionMethodSchema,
  model: z.string(),
  request: decisionRequestSchema,
  answers: z.record(z.string(), decisionAnswerSchema),
  /** sha256 of the questions (not the state), 12 hex chars — the "which policy" fingerprint. */
  questionsHash: z.string(),
  latencyMs: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
})
export type AgentRunDecision = z.infer<typeof agentRunDecisionSchema>

/** The `data` of a `decision` event row: thin — the table is the store. */
export const agentDecisionEventDataSchema = z.object({
  decisionId: z.string().uuid(),
  key: z.string(),
  provider: z.string(),
  method: decisionMethodSchema,
  answers: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['noul', 'choice', 'score']),
        /** `yes`/`no` for a noul, the option id for a choice, the rounded level for a score. */
        answer: z.string(),
        confidence: probabilitySchema,
      })
    )
    .max(DECISION_MAX_QUESTIONS),
})
export type AgentDecisionEventData = z.infer<typeof agentDecisionEventDataSchema>

// ---- confidence (TypeSafe's published definitions) -----------------------------------------

/** Noul: distance from a coin toss. */
export function noulConfidence(p: number): number {
  return clamp01(Math.abs(2 * p - 1))
}

/** Choice: how far the top option stands above an even spread. Only the top probability counts. */
export function choiceConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length
  if (n < 2) return 1
  const max = Math.max(...probabilities)
  return clamp01((max - 1 / n) / (1 - 1 / n))
}

/**
 * Score: probability-weighted distance from the most likely level, against the same distance for
 * an even spread — adjacent levels cost less than distant ones. TypeSafe describes this shape
 * without publishing the formula, so Jev's own `confidence` is used verbatim when it answers; this
 * is what the LLM fallback reports.
 */
export function scoreConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length
  if (n < 2) return 1
  const mode = probabilities.indexOf(Math.max(...probabilities))
  const spread = probabilities.reduce((sum, p, i) => sum + p * Math.abs(i - mode), 0)
  const even = probabilities.reduce((sum, _p, i) => sum + Math.abs(i - mode) / n, 0)
  return even === 0 ? 1 : clamp01(1 - spread / even)
}

/** The answer as one short string — what a timeline row and an eval expectation compare. */
export function decisionAnswerLabel(answer: DecisionAnswer): string {
  if (answer.type === 'noul') return (answer.noul ?? 0) >= 0.5 ? 'yes' : 'no'
  if (answer.type === 'choice') return answer.choice ?? ''
  return String(Math.round(answer.score ?? 0))
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}
