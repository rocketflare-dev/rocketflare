/**
 * The deterministic scorers, as plain functions over plain values so they can be unit-tested,
 * borrowed by an app's own judges, and reasoned about without a model in the loop. Every one returns
 * a score in `[0, 1]` and a sentence saying why — the sentence is what `pnpm eval` prints and the
 * `rf-evals` skill reads back to the user.
 *
 * Trajectory semantics follow agentevals (https://github.com/langchain-ai/agentevals):
 * - `strict`    — exactly the expected tools, in the expected order;
 * - `unordered` — the same tools the same number of times, any order;
 * - `subset`    — the agent called nothing OUTSIDE the expected set (it may skip some);
 * - `superset`  — the agent called at least every expected tool (it may call more).
 */
import {
  EVAL_TRAJECTORY_MODES,
  type EvalExpectedTool,
  type EvalTrajectoryMode,
} from '@rocketflare/shared/ai/evals'
import type { ZodTypeAny } from 'zod'

export interface Score {
  score: number
  rationale: string
}

export const TRAJECTORY_MODES = EVAL_TRAJECTORY_MODES
export type TrajectoryMode = EvalTrajectoryMode

export function expectedToolNames(tools: readonly EvalExpectedTool[] | undefined): string[] {
  return (tools ?? []).map(t => (typeof t === 'string' ? t : t.name))
}

function counts(names: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const name of names) out.set(name, (out.get(name) ?? 0) + 1)
  return out
}

export function trajectoryScore(
  actual: readonly string[],
  expected: readonly string[],
  mode: TrajectoryMode
): Score {
  const shown = (names: readonly string[]) => (names.length ? names.join(' → ') : '(no tools)')
  const said = `called ${shown(actual)}; expected ${shown(expected)} (${mode})`
  let pass: boolean
  switch (mode) {
    case 'strict':
      pass = actual.length === expected.length && actual.every((name, i) => name === expected[i])
      break
    case 'unordered': {
      const a = counts(actual)
      const e = counts(expected)
      pass = a.size === e.size && [...e].every(([name, n]) => a.get(name) === n)
      break
    }
    case 'subset': {
      const allowed = new Set(expected)
      pass = actual.every(name => allowed.has(name))
      break
    }
    case 'superset': {
      const called = new Set(actual)
      pass = expected.every(name => called.has(name))
      break
    }
  }
  return { score: pass ? 1 : 0, rationale: said }
}

/** Case-insensitive substrings; the score is the fraction found, so one miss in four is 0.75. */
export function containsScore(output: string, needles: readonly string[]): Score {
  if (needles.length === 0) return { score: 1, rationale: 'nothing required' }
  const haystack = output.toLowerCase()
  const missing = needles.filter(n => !haystack.includes(n.toLowerCase()))
  return {
    score: (needles.length - missing.length) / needles.length,
    rationale: missing.length
      ? `missing ${missing.map(m => JSON.stringify(m)).join(', ')}`
      : `contains all ${needles.length}`,
  }
}

export function regexScore(output: string, pattern: RegExp): Score {
  const pass = pattern.test(output)
  return { score: pass ? 1 : 0, rationale: `${pass ? 'matches' : 'does not match'} ${pattern}` }
}

export function schemaScore(output: unknown, schema: ZodTypeAny): Score {
  const parsed = schema.safeParse(output)
  if (parsed.success) return { score: 1, rationale: 'matches the schema' }
  const issues = parsed.error.issues
    .slice(0, 3)
    .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
  return { score: 0, rationale: `schema: ${issues.join('; ')}` }
}

export interface Budget {
  maxMs?: number
  maxTokens?: number
  maxCostUsd?: number
}

export interface Spend {
  totalMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/** Pass/fail against every limit given; unknown spend (a provider with no price) never fails. */
export function budgetScore(spend: Spend, budget: Budget): Score {
  const over: string[] = []
  const tokens = (spend.inputTokens ?? 0) + (spend.outputTokens ?? 0)
  if (budget.maxMs !== undefined && (spend.totalMs ?? 0) > budget.maxMs) {
    over.push(`${spend.totalMs}ms > ${budget.maxMs}ms`)
  }
  if (budget.maxTokens !== undefined && tokens > budget.maxTokens) {
    over.push(`${tokens} tokens > ${budget.maxTokens}`)
  }
  if (
    budget.maxCostUsd !== undefined &&
    spend.costUsd !== undefined &&
    spend.costUsd > budget.maxCostUsd
  ) {
    over.push(`$${spend.costUsd.toFixed(4)} > $${budget.maxCostUsd}`)
  }
  return {
    score: over.length ? 0 : 1,
    rationale: over.length ? `over budget: ${over.join(', ')}` : 'within budget',
  }
}

/** What a text judge reads: a string as-is, anything else as pretty JSON. */
export function outputText(output: unknown): string {
  if (output === undefined || output === null) return ''
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2)
}

// ---- decisions ----------------------------------------------------------------------------

/** One recorded answer as the agent target reports it: its label and the probabilities behind it. */
export interface RecordedAnswer {
  type: 'noul' | 'choice' | 'score'
  label: string
  confidence: number
  /** P(yes) for a noul; the distribution for a choice/score. */
  noul?: number
  probabilities?: Record<string, number>
}

/** decision key → question id → answer. */
export type RecordedDecisions = Record<string, Record<string, RecordedAnswer>>

/**
 * How many expected answers the run gave, plus the Brier score over them (lower is better; 0 is a
 * certain, correct answer, 1 a certain, wrong one). Accuracy is the score; Brier rides in the
 * rationale because it is what separates a confident right answer from a lucky coin toss — the
 * difference calibration is for. A question the run never asked counts as wrong.
 */
export function decisionScore(
  recorded: RecordedDecisions,
  expected: Record<string, Record<string, string>>
): Score & { brier: number | null } {
  let total = 0
  let correct = 0
  const briers: number[] = []
  const misses: string[] = []
  for (const [key, questions] of Object.entries(expected)) {
    for (const [id, want] of Object.entries(questions)) {
      total += 1
      const got = recorded[key]?.[id]
      if (!got) {
        misses.push(`${key}.${id}: not asked`)
        continue
      }
      if (got.label === want) correct += 1
      else misses.push(`${key}.${id}: ${got.label} ≠ ${want}`)
      const brier = brierOf(got, want)
      if (brier !== null) briers.push(brier)
    }
  }
  if (total === 0) return { score: 1, rationale: 'no expected decisions', brier: null }
  const brier = briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null
  const tail = brier === null ? '' : ` · Brier ${brier.toFixed(3)}`
  return {
    score: correct / total,
    rationale:
      misses.length === 0
        ? `${correct}/${total} decisions as expected${tail}`
        : `${correct}/${total} as expected — ${misses.join('; ')}${tail}`,
    brier,
  }
}

function brierOf(answer: RecordedAnswer, want: string): number | null {
  if (answer.type === 'noul' && answer.noul !== undefined) {
    const y = want === 'yes' ? 1 : 0
    return (answer.noul - y) ** 2
  }
  if (!answer.probabilities) return null
  // Multi-class Brier, halved so it sits on the same 0–1 scale as the binary one.
  const keys = new Set([...Object.keys(answer.probabilities), want])
  let sum = 0
  for (const k of keys) sum += ((answer.probabilities[k] ?? 0) - (k === want ? 1 : 0)) ** 2
  return sum / 2
}
