/**
 * The judge catalogue (D33). Every judge reads the CASE from `ctx.input` — the harness input IS the
 * `EvalCase` — so a suite lists its judges once and each case brings its own expectations
 * (`expected.contains`, `expected.tools`, `expected.rubric`, `expected.output`). A judge with
 * nothing to check for a case returns `score: null`: unscored, never a free pass or a false fail.
 *
 * Deterministic (free, instant — prefer them): `ContainsJudge`, `MatchesJudge`, `SchemaJudge`,
 * `TrajectoryJudge`, `BudgetJudge`. LLM (costed, through `judgeHarness`): `RubricJudge`,
 * `FaithfulnessJudge`, `ReferenceJudge` (vitest-evals' `FactualityJudge` against
 * `expected.output`). The pure scoring lives in `scoring.ts`; `reference.md` in the `rf-evals`
 * skill is the catalogue a person reads.
 */
import type { EvalCase, EvalContextDoc } from '@rocketflare/shared/ai/evals'
import {
  FactualityJudge,
  type JsonValue,
  type Judge,
  type JudgeContext,
  type JudgeResult,
} from 'vitest-evals'
import type { ZodTypeAny } from 'zod'
import { judgeHarness } from './judge-harness'
import {
  type Budget,
  budgetScore,
  containsScore,
  expectedToolNames,
  outputText,
  regexScore,
  type Score,
  schemaScore,
  type TrajectoryMode,
  trajectoryScore,
} from './scoring'

// biome-ignore lint/suspicious/noExplicitAny: a judge runs over any target's output type
type Ctx = JudgeContext<EvalCase, any>
export type EvalJudge = Judge<Ctx> & {
  /** Does this case give the judge something to check? Absent = always. */
  appliesTo?: (evalCase: EvalCase) => boolean
}

/** A backstop only: `appliesTo` should have kept the judge off a case it cannot score. */
const unscored = (why: string): JudgeResult => ({ score: null, metadata: { rationale: why } })
const scored = ({ score, rationale }: Score): JudgeResult => ({ score, metadata: { rationale } })

function judge(
  name: string,
  assess: (ctx: Ctx) => Promise<JudgeResult> | JudgeResult,
  appliesTo?: (evalCase: EvalCase) => boolean
): EvalJudge {
  return { name, assess, ...(appliesTo ? { appliesTo } : {}) }
}

// ---- deterministic -------------------------------------------------------------------------------

/** Every `expected.contains` substring appears in the output (case-insensitive). */
export const ContainsJudge = (): EvalJudge =>
  judge(
    'Contains',
    ({ input, output }) =>
      input.expected.contains?.length
        ? scored(containsScore(outputText(output), input.expected.contains))
        : unscored('case has no expected.contains'),
    c => Boolean(c.expected.contains?.length)
  )

/** The output matches a regular expression. */
export const MatchesJudge = (pattern: RegExp, name = 'Matches'): EvalJudge =>
  judge(name, ({ output }) => scored(regexScore(outputText(output), pattern)))

/** The output parses with a zod schema — structured output that the app can actually use. */
export const SchemaJudge = (schema: ZodTypeAny, name = 'Schema'): EvalJudge =>
  judge(name, ({ output }) => scored(schemaScore(output, schema)))

/**
 * The tools called, against `expected.tools`, per agentevals trajectory semantics. `mode` is the
 * suite's default; a case's `expected.toolsMatch` overrides it (`strict` + `[]` = "call nothing").
 */
export const TrajectoryJudge = (mode: TrajectoryMode = 'superset'): EvalJudge =>
  judge(
    'Trajectory',
    ({ input, toolCalls }) =>
      input.expected.tools
        ? scored(
            trajectoryScore(
              toolCalls.map(c => c.name),
              expectedToolNames(input.expected.tools),
              input.expected.toolsMatch ?? mode
            )
          )
        : unscored('case has no expected.tools'),
    c => c.expected.tools !== undefined
  )

/** Latency, token and cost ceilings for the whole case. Unknown cost never fails it. */
export const BudgetJudge = (budget: Budget): EvalJudge =>
  judge('Budget', ({ run }) =>
    scored(
      budgetScore(
        {
          totalMs: run.timings?.totalMs,
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          costUsd: run.usage.costUsd,
        },
        budget
      )
    )
  )

// ---- LLM-as-judge --------------------------------------------------------------------------------

async function askJudge(
  ctx: Ctx,
  system: string,
  prompt: string
): Promise<Record<string, JsonValue>> {
  const run = ctx.runJudge ?? ((input: Parameters<typeof judgeHarness.run>[0]) => runOnce(input))
  const verdict = await run({ system, prompt, responseFormat: { type: 'json' } })
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    throw new Error(`judge did not answer JSON: ${String(verdict).slice(0, 200)}`)
  }
  return verdict as Record<string, JsonValue>
}

async function runOnce(input: Parameters<typeof judgeHarness.run>[0]) {
  const run = await judgeHarness.run(input, { artifacts: {}, setArtifact: () => {} })
  return run.output
}

const question = (input: EvalCase) =>
  typeof input.input === 'string' ? input.input : JSON.stringify(input.input, null, 2)

const RUBRIC_SYSTEM = `Grade the answer against the rubric. Reply with JSON:
{"verdict": "pass" | "partial" | "fail", "rationale": "<one or two sentences>"}
"pass" = every criterion met; "partial" = some met, nothing wrong; "fail" = a criterion missed or anything false.`

/** Grades the output against the case's plain-language `expected.rubric`. */
export const RubricJudge = (): EvalJudge =>
  judge(
    'Rubric',
    async ctx => {
      const rubric = ctx.input.expected.rubric
      if (!rubric) return unscored('case has no expected.rubric')
      const verdict = await askJudge(
        ctx,
        RUBRIC_SYSTEM,
        `TASK\n${question(ctx.input)}\n\nANSWER\n${outputText(ctx.output)}\n\nRUBRIC\n${rubric}`
      )
      const score = { pass: 1, partial: 0.5, fail: 0 }[String(verdict.verdict)] ?? 0
      return { score, metadata: { rationale: String(verdict.rationale ?? ''), output: verdict } }
    },
    c => Boolean(c.expected.rubric)
  )

const FAITHFULNESS_SYSTEM = `Check whether every factual claim in the answer is supported by the retrieved context.
Ignore claims about the conversation itself, greetings, and statements that the context does not cover.
Reply with JSON: {"supported": <number of supported claims>, "unsupported": ["<each unsupported claim>"], "rationale": "<one sentence>"}`

function contextBlock(docs: readonly EvalContextDoc[]): string {
  return docs.map((d, i) => `[${i + 1}] ${d.title}\n${d.text}`).join('\n\n')
}

/**
 * Is the answer grounded in what retrieval ACTUALLY returned (`artifacts.retrieved`, read from the
 * tool results)? The score is supported / (supported + unsupported). It applies to a case that
 * brings documents and does not pin "call no tools"; a run that then retrieved nothing scores 0 —
 * its answer is grounded in nothing — and the trajectory judge says why.
 */
export const FaithfulnessJudge = (): EvalJudge =>
  judge(
    'Faithfulness',
    async ctx => {
      const retrieved = (ctx.run.artifacts?.retrieved ?? []) as unknown as EvalContextDoc[]
      if (!Array.isArray(retrieved) || retrieved.length === 0) {
        return { score: 0, metadata: { rationale: 'nothing was retrieved to ground the answer' } }
      }
      const verdict = await askJudge(
        ctx,
        FAITHFULNESS_SYSTEM,
        `QUESTION\n${question(ctx.input)}\n\nRETRIEVED CONTEXT\n${contextBlock(retrieved)}\n\nANSWER\n${outputText(ctx.output)}`
      )
      const supported = Number(verdict.supported ?? 0)
      const unsupported = Array.isArray(verdict.unsupported) ? verdict.unsupported : []
      const total = supported + unsupported.length
      return {
        score: total === 0 ? 1 : supported / total,
        metadata: {
          rationale: unsupported.length
            ? `unsupported: ${unsupported.map(String).join('; ')}`
            : String(verdict.rationale ?? 'every claim is supported'),
          output: verdict,
        },
      }
    },
    c =>
      c.context.length > 0 &&
      !(c.expected.tools?.length === 0 && (c.expected.toolsMatch ?? 'strict') === 'strict')
  )

const factuality = FactualityJudge({ name: 'Reference', judgeHarness })

/** vitest-evals' factuality rubric (A–E) against the case's reference answer, `expected.output`. */
export const ReferenceJudge = (): EvalJudge =>
  judge(
    'Reference',
    ctx => {
      const expected = ctx.input.expected.output
      if (expected === undefined || expected === null || expected === '') {
        return unscored('case has no expected.output')
      }
      return factuality.assess({
        ...ctx,
        input: question(ctx.input),
        output: outputText(ctx.output),
        expected: expected as JsonValue,
      })
    },
    c => c.expected.output !== undefined && c.expected.output !== null && c.expected.output !== ''
  )
