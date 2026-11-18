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

// ---- retrieval ----------------------------------------------------------------------------

/** One retrieved passage as a retrieval scorer sees it: which corpus document, and its text. */
export interface RankedPassage {
  doc: string
  text: string
}

export interface ExpectedPassage {
  doc: string
  passage: string
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Does a retrieved chunk carry the expected passage? Verbatim (whitespace and case aside), or — for
 * a passage the chunker cut in two — at least half of it on either side of the cut: the chunk ends
 * with the passage's start, or begins with its end. Overlap normally makes the whole passage appear
 * in one chunk; this is the fallback for a window that still split it.
 */
export function passageCovered(chunk: string, passage: string): boolean {
  const c = squash(chunk)
  const p = squash(passage)
  if (!p) return false
  if (c.includes(p)) return true
  const half = Math.ceil(p.length / 2)
  for (let n = p.length - 1; n >= half; n -= 1) {
    if (c.endsWith(p.slice(0, n)) || c.startsWith(p.slice(p.length - n))) return true
  }
  return false
}

/** The 1-based rank of the first hit carrying each expected passage, or null when none does. */
export function passageRanks(
  hits: readonly RankedPassage[],
  expected: readonly ExpectedPassage[]
): (number | null)[] {
  return expected.map(e => {
    const i = hits.findIndex(h => h.doc === e.doc && passageCovered(h.text, e.passage))
    return i === -1 ? null : i + 1
  })
}

/** Share of the expected passages found in the top `k`. */
export function recallAtK(ranks: readonly (number | null)[], k: number): Score {
  if (ranks.length === 0) return { score: 1, rationale: 'nothing expected' }
  const found = ranks.filter(r => r !== null && r <= k).length
  const shown = ranks.map(r => (r === null ? '—' : `#${r}`)).join(', ')
  return {
    score: found / ranks.length,
    rationale: `${found}/${ranks.length} expected passages in the top ${k} (ranks ${shown})`,
  }
}

/** 1 / the rank of the first expected passage found; 0 when none was. */
export function reciprocalRank(ranks: readonly (number | null)[]): Score {
  const found = ranks.filter((r): r is number => r !== null)
  if (found.length === 0) return { score: 0, rationale: 'no expected passage retrieved' }
  const best = Math.min(...found)
  return { score: 1 / best, rationale: `first expected passage at #${best}` }
}

/**
 * Average precision over a judged ranking: the mean of precision@i at every relevant position.
 * `relevant[i]` is the judge's verdict on hit i. Rewards putting the relevant passages FIRST, which
 * is what a model reading the top of the list needs.
 */
export function averagePrecision(relevant: readonly boolean[]): Score {
  let hits = 0
  let sum = 0
  relevant.forEach((r, i) => {
    if (!r) return
    hits += 1
    sum += hits / (i + 1)
  })
  if (relevant.length === 0) return { score: 0, rationale: 'nothing was retrieved' }
  return {
    score: hits === 0 ? 0 : sum / hits,
    rationale: `${hits}/${relevant.length} retrieved passages relevant (${relevant.map(r => (r ? '✓' : '·')).join('')})`,
  }
}

// ---- facts --------------------------------------------------------------------------------

/** A fact as an extractor reports it — or as the answer key plants it. */
export interface FactClaim {
  /** The answer key's id; an extracted fact has none until it is matched. */
  id?: string
  entityType: string
  entity: string
  key: string
  value: unknown
  doc: string
  /**
   * For a fact whose key names an entity (`refs`): every name of the entity its value resolved to.
   * The system knows "Marcus" is Marcus Bell once both resolve to one person, so either matches.
   */
  valueNames?: readonly string[]
}

/**
 * Lower-case, punctuation dropped, whitespace collapsed, a trailing legal form dropped —
 * `"Harbour View Dental, Ltd."` → `harbour view dental`. A company's registered suffix (`Ltd`,
 * `Limited`, `LLP`, `PLC`, `Co`, `Inc`) names the same organisation with or without it.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/(?:\s+(?:ltd|limited|llp|plc|co|inc))+$/u, '')
}

/**
 * Values equal after normalisation: numbers within a penny, strings case- and whitespace-blind
 * (a numeric string compares as its number, `£1,140` as 1140), arrays as sets, booleans and dates
 * as themselves.
 */
export function valuesMatch(a: unknown, b: unknown): boolean {
  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return v
    if (typeof v !== 'string') return null
    const cleaned = v.replace(/[£$€,\s]/g, '')
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    const left = new Set(a.map(v => squash(String(v))))
    const right = new Set(b.map(v => squash(String(v))))
    return left.size === right.size && [...left].every(v => right.has(v))
  }
  const na = num(a)
  const nb = num(b)
  if (na !== null && nb !== null) return Math.abs(na - nb) < 0.005
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b
  return squash(String(a ?? '')) === squash(String(b ?? ''))
}

/** name or alias (normalised) → the canonical entity name, per entity type. */
export type EntityIndex = Map<string, string>

export function entityIndex(
  entities: readonly { entityType: string; name: string; aliases: readonly string[] }[]
): EntityIndex {
  const index: EntityIndex = new Map()
  for (const e of entities) {
    for (const n of [e.name, ...e.aliases]) {
      index.set(`${e.entityType}:${normalizeName(n)}`, e.name)
    }
  }
  return index
}

function canonical(index: EntityIndex, entityType: string, entity: string): string {
  return index.get(`${entityType}:${normalizeName(entity)}`) ?? entity
}

/**
 * Pair each extracted fact with at most one planted fact: same document, entity type, entity (via
 * names and aliases), key and value. Returns planted id per extracted fact (null = unmatched).
 */
export function matchFacts(
  extracted: readonly FactClaim[],
  planted: readonly FactClaim[],
  index: EntityIndex
): (string | null)[] {
  const used = new Set<string>()
  return extracted.map(x => {
    const name = canonical(index, x.entityType, x.entity)
    const hit = planted.find(
      p =>
        p.id !== undefined &&
        !used.has(p.id) &&
        p.doc === x.doc &&
        p.entityType === x.entityType &&
        normalizeName(canonical(index, p.entityType, p.entity)) === normalizeName(name) &&
        p.key === x.key &&
        [x.value, ...(x.valueNames ?? [])].some(v => valuesMatch(p.value, v))
    )
    if (!hit?.id) return null
    used.add(hit.id)
    return hit.id
  })
}

export interface ExtractionScore extends Score {
  precision: number
  recall: number
  matched: number
}

/** Precision and recall of `extracted` against `planted`; the score is F1. */
export function factExtractionScore(
  extracted: readonly FactClaim[],
  planted: readonly FactClaim[],
  index: EntityIndex
): ExtractionScore {
  const matches = matchFacts(extracted, planted, index)
  const matched = matches.filter(Boolean).length
  const precision =
    extracted.length === 0 ? (planted.length === 0 ? 1 : 0) : matched / extracted.length
  const recall = planted.length === 0 ? 1 : matched / planted.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    score: f1,
    precision,
    recall,
    matched,
    rationale: `precision ${precision.toFixed(2)} (${matched}/${extracted.length}) · recall ${recall.toFixed(2)} (${matched}/${planted.length})`,
  }
}

export interface ConflictScore extends Score {
  caught: number
  falseAlarmRate: number
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|')

/**
 * Share of planted conflicts flagged, and share of flags that are false alarms. `flagged` holds
 * pairs of PLANTED fact ids (an extracted conflict is mapped through `matchFacts` first; a flag on
 * a fact that matched nothing has no id and counts as a false alarm via `unmatchedFlags`).
 */
export function conflictDetectionScore(
  flagged: readonly [string, string][],
  planted: readonly { a: string; b: string }[],
  unmatchedFlags = 0
): ConflictScore {
  const want = new Set(planted.map(p => pairKey(p.a, p.b)))
  const got = new Set(flagged.map(([a, b]) => pairKey(a, b)))
  const caught = [...want].filter(k => got.has(k)).length
  const falseAlarms = [...got].filter(k => !want.has(k)).length + unmatchedFlags
  const flags = got.size + unmatchedFlags
  const caughtShare = want.size === 0 ? 1 : caught / want.size
  const falseAlarmRate = flags === 0 ? 0 : falseAlarms / flags
  return {
    score: caughtShare * (1 - falseAlarmRate),
    caught: caughtShare,
    falseAlarmRate,
    rationale: `caught ${caught}/${want.size} planted conflicts · ${falseAlarms}/${flags} flags false alarms`,
  }
}
