/**
 * `describeCases(name, { harness, judges, cases })` (D33) — `describeEval` once per case, each with
 * only the judges that case gives something to check (`EvalJudge.appliesTo`). vitest-evals averages
 * a `null` score as 0, so a suite-wide judge list would fail a greeting for having no
 * `expected.contains`; attaching per case keeps every average honest. Every block shares the suite
 * name, so reports and baselines still read `<suite> › <case id>`.
 */
import type { EvalCase } from '@rocketflare/shared/ai/evals'
import { describeEval, type Harness, type JsonValue } from 'vitest-evals'
import { skipEvals } from './env'
import { judgeHarness } from './judge-harness'
import type { EvalJudge } from './judges'

export interface DescribeCasesOptions<TOutput extends JsonValue | undefined> {
  harness: Harness<EvalCase, TOutput>
  judges: EvalJudge[]
  cases: EvalCase[]
  /** Mean judge score a case must reach to pass (default 0.7). */
  threshold?: number
}

export function describeCases<TOutput extends JsonValue | undefined>(
  name: string,
  { harness, judges, cases, threshold = 0.7 }: DescribeCasesOptions<TOutput>
): void {
  for (const evalCase of cases) {
    describeEval(
      name,
      {
        harness,
        judgeHarness,
        judges: judges.filter(j => j.appliesTo?.(evalCase) ?? true),
        judgeThreshold: threshold,
        skipIf: skipEvals,
      },
      it => {
        it(evalCase.id, async ({ run }) => {
          await run(evalCase)
        })
      }
    )
  }
}
