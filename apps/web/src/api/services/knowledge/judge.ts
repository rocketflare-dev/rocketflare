/**
 * The questions extraction asks a decision model (D43) where comparing text would be guessing:
 *
 * - **Values** — two facts give one entity and key different values (`valueKey` differs). Do
 *   they say the same thing ("per call-out" / "per visit"), is one a more specific form of the
 *   other ("Marcus" / "Marcus Bell"), or do they disagree?
 * - **Entities** — a mention resolved to no entity, but known entities of its type look close
 *   ("Winter gritting (annual plan)" beside "Car park and entrances gritting (annual plan, per
 *   site)"). Is it one of them, or a new one?
 *
 * **The model answers, code decides.** Each is a typed `choice` (`DecisionRequest`) through
 * `resolveDecisions` — TypeSafe's Jev when configured, else the chat model on `knowledge-decide`
 * (its own prompt key, so a cheap model can be pinned to it). An answer changes something only at
 * `JUDGE_MIN_PROBABILITY`; anything less, a failure, or no model at all is `null`, and the caller
 * keeps the literal rule — so a weak or absent model can only leave a false alarm in place, never
 * hide a disagreement or link two different things.
 *
 * No string rules about names, units or languages live here: the passages are handed over as
 * written, in whatever language, and the model judges meaning.
 *
 * Batched: one request per call, at most `DECISION_MAX_QUESTIONS` questions each. Metered as
 * `knowledge.extraction` (it counts against `KNOWLEDGE_TENANT_DAILY_COST_USD`).
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import {
  DECISION_MAX_QUESTIONS,
  type DecisionMethod,
  type DecisionQuestion,
} from '@rocketflare/shared/ai/decisions'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { ValueVerdict } from '../../../db/schema'
import { traceStep } from '../../observability/context'
import { AiNotConfiguredError } from '../ai/errors'
import { type ResolvedDecisions, resolveDecisions } from '../ai/resolve'
import type { AiEnv } from '../ai/types'
import { recordUsage } from '../ai/usage'
import { resolvePrompt } from '../prompts'

/** The prompt key the chat fallback resolves its model and system prompt on. */
export const KNOWLEDGE_DECIDE_PROMPT_KEY = 'knowledge-decide' as const

/** At or above it an answer is acted on; below, the literal rule stands. */
export const JUDGE_MIN_PROBABILITY = 0.8

export interface FactSide {
  /** The value as stored (`valueText`). */
  value: string
  /** The passage it was read from, verbatim. */
  quote: string
  /** The document's title, for context. */
  document: string
}

export interface ValueQuestion {
  entity: { type: string; label: string; name: string }
  key: string
  /** The key's `.describe()`, when it has one — what the value means. */
  meaning?: string
  a: FactSide
  b: FactSide
}

export interface Judgement<T> {
  answer: T
  /** The probability of `answer`. */
  confidence: number
  method: DecisionMethod
  model: string
}

export interface EntityCandidateView {
  id: string
  name: string
  aliases: readonly string[]
  /** `key = value` lines of what is held about it, a few. */
  facts: readonly string[]
}

export interface EntityQuestion {
  type: string
  label: string
  mention: {
    names: readonly string[]
    /** `key = value` lines this section states about the mention. */
    facts: readonly string[]
    /** The passages those facts were read from. */
    quotes: readonly string[]
    document: string
  }
  candidates: readonly EntityCandidateView[]
}

/**
 * Per question: the answer, `null` (asked, and the model was unsure — the literal rule, and worth
 * remembering), or `undefined` (not answered: no engine, or the call failed — ask again later).
 */
export type JudgeAnswer<T> = Judgement<T> | null | undefined

export interface KnowledgeJudge {
  /** The engine that would answer, or null when none resolves (no model at all). */
  engine(): Promise<{ method: DecisionMethod; model: string } | null>
  /** A verdict per question: `same`, or `compatible` (one a more specific form of the other). */
  values(
    questions: readonly ValueQuestion[]
  ): Promise<JudgeAnswer<Exclude<ValueVerdict, 'different'>>[]>
  /** Per question: a candidate's id (the same entity), or `'new'` (confidently none of them). */
  entities(questions: readonly EntityQuestion[]): Promise<JudgeAnswer<string>[]>
}

const VALUE_OPTIONS = {
  same: 'The two values say the same thing: another wording, format, unit name, spelling or language of ONE value.',
  more_specific:
    'They do not contradict, but one is a shorter or less specific form of the other: a first name and the full name, a street and the full address.',
  different:
    'They disagree: two different amounts, dates, people, places or options — or the passages do not make clear that they agree.',
} as const

/** The pieces `createKnowledgeJudge` needs; a test passes its own `resolve`. */
export interface JudgeDeps {
  db: Database
  tenantId: string
  userId: string | null
  resolve: () => Promise<ResolvedDecisions | null>
  logger?: { warn: (obj: object, msg: string) => void }
}

/** The judge for one tenant, resolving its engine on first use; null engine = every answer null. */
export function createKnowledgeJudge(deps: JudgeDeps): KnowledgeJudge {
  let engine: Promise<ResolvedDecisions | null> | undefined
  const engineOnce = () => {
    engine ??= deps.resolve().catch(err => {
      deps.logger?.warn({ error: String(err).slice(0, 200) }, 'knowledge judge: no decision engine')
      return null
    })
    return engine
  }

  async function ask(
    name: string,
    state: unknown,
    questions: Record<string, DecisionQuestion>
  ): Promise<Record<string, { choice: string; p: number }> | null> {
    const resolved = await engineOnce()
    if (!resolved) return null
    try {
      return await traceStep(
        { name, kind: 'span', input: { questions: Object.keys(questions).length } },
        async () => {
          const result = await resolved.client.ask({ state, questions }, { model: resolved.model })
          await meter(result.usage, resolved, result.model)
          const out: Record<string, { choice: string; p: number }> = {}
          for (const [id, a] of Object.entries(result.answers)) {
            if (!a.choice) continue
            out[id] = { choice: a.choice, p: a.probabilities?.[a.choice] ?? 0 }
          }
          return out
        }
      )
    } catch (err) {
      deps.logger?.warn(
        { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
        'knowledge judge: decision failed, literal rule kept'
      )
      return null
    }
  }

  async function meter(usage: TokenUsage, resolved: ResolvedDecisions, model: string) {
    try {
      await recordUsage(deps.db, {
        tenantId: deps.tenantId,
        userId: deps.userId,
        feature: KNOWLEDGE_USAGE_FEATURES.extraction,
        provider: resolved.provider,
        model,
        usage,
      })
    } catch {
      // Metering never fails the judgement.
    }
  }

  const methodOf = async () => (await engineOnce())?.method ?? 'llm_self_report'
  const modelOf = async () => (await engineOnce())?.model ?? ''

  return {
    async engine() {
      const resolved = await engineOnce()
      return resolved ? { method: resolved.method, model: resolved.model } : null
    },

    async values(questions) {
      const out: JudgeAnswer<'same' | 'compatible'>[] = questions.map(() => undefined)
      for (let start = 0; start < questions.length; start += DECISION_MAX_QUESTIONS) {
        const batch = questions.slice(start, start + DECISION_MAX_QUESTIONS)
        const state: Record<string, unknown> = {}
        const asked: Record<string, DecisionQuestion> = {}
        batch.forEach((q, i) => {
          const id = `pair_${i}`
          state[id] = {
            entity: `${q.entity.label} "${q.entity.name}"`,
            fact: q.key,
            meaning: q.meaning,
            first: q.a,
            second: q.b,
          }
          asked[id] = {
            type: 'choice',
            instructions: `In ${id} of the state, two passages give the "${q.key}" of the same ${q.entity.label}. Do the two values agree?`,
            criteria: VALUE_OPTIONS,
          }
        })
        const answers = await ask('knowledge judge values', state, asked)
        if (!answers) continue
        const method = await methodOf()
        const model = await modelOf()
        batch.forEach((_q, i) => {
          const a = answers[`pair_${i}`]
          out[start + i] = null
          if (!a || a.p < JUDGE_MIN_PROBABILITY || a.choice === 'different') return
          out[start + i] = {
            answer: a.choice === 'same' ? 'same' : 'compatible',
            confidence: a.p,
            method,
            model,
          }
        })
      }
      return out
    },

    async entities(questions) {
      const out: JudgeAnswer<string>[] = questions.map(() => undefined)
      for (let start = 0; start < questions.length; start += DECISION_MAX_QUESTIONS) {
        const batch = questions.slice(start, start + DECISION_MAX_QUESTIONS)
        const state: Record<string, unknown> = {}
        const asked: Record<string, DecisionQuestion> = {}
        batch.forEach((q, i) => {
          const id = `mention_${i}`
          state[id] = {
            type: q.label,
            mention: q.mention,
            known: Object.fromEntries(
              q.candidates.map((c, n) => [
                `known_${n}`,
                { name: c.name, otherNames: c.aliases, facts: c.facts },
              ])
            ),
          }
          const criteria: Record<string, string> = {}
          q.candidates.forEach((c, n) => {
            criteria[`known_${n}`] =
              `The mention is the same ${q.label} as the known one called "${c.name}" (${id}.known.known_${n}).`
          })
          criteria.new = `The mention is a different ${q.label} from every known one listed — or the passages do not make clear that it is one of them.`
          asked[id] = {
            type: 'choice',
            instructions: `In ${id} of the state, a passage of "${q.mention.document}" names a ${q.label}. Is it one of the known ${q.label} entities listed beside it?`,
            criteria,
          }
        })
        const answers = await ask('knowledge judge entities', state, asked)
        if (!answers) continue
        const method = await methodOf()
        const model = await modelOf()
        batch.forEach((q, i) => {
          const a = answers[`mention_${i}`]
          out[start + i] = null
          if (!a || a.p < JUDGE_MIN_PROBABILITY) return
          if (a.choice === 'new') {
            out[start + i] = { answer: 'new', confidence: a.p, method, model }
            return
          }
          const n = Number(a.choice.replace('known_', ''))
          const candidate = q.candidates[n]
          if (candidate) out[start + i] = { answer: candidate.id, confidence: a.p, method, model }
        })
      }
      return out
    },
  }
}

/** The judge extraction uses: TypeSafe when configured, else the chat model on `knowledge-decide`. */
export function knowledgeJudgeFor(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  userId: string | null,
  tenantName: string,
  logger?: JudgeDeps['logger']
): KnowledgeJudge {
  return createKnowledgeJudge({
    db,
    tenantId,
    userId,
    logger,
    resolve: async () => {
      try {
        return await resolveDecisions(db, cfg, env, tenantId, {
          fallbackPromptKey: KNOWLEDGE_DECIDE_PROMPT_KEY,
          fallbackSystem: await resolvePrompt(db, tenantId, KNOWLEDGE_DECIDE_PROMPT_KEY, {
            appName: cfg.APP_NAME,
            tenantName,
          }),
        })
      } catch (err) {
        if (err instanceof AiNotConfiguredError) return null
        throw err
      }
    },
  })
}
