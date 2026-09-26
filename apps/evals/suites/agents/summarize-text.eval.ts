/**
 * The `summarize-text` agent (D33): one forced `submit_summary` call. The structured output must
 * parse (`Schema`), keep the facts that matter (`Contains`), follow the requested style and add
 * nothing (`Rubric`), and stay cheap (`Budget` — it is a single model call).
 */
import { summarizeTextOutputSchema } from '@rocketflare/shared/ai/agents'
import {
  agentHarness,
  BudgetJudge,
  ContainsJudge,
  describeCases,
  loadDataset,
  RubricJudge,
  SchemaJudge,
} from '../../kit'

describeCases('agent · summarize-text', {
  harness: agentHarness('summarize-text'),
  judges: [
    SchemaJudge(summarizeTextOutputSchema),
    ContainsJudge(),
    RubricJudge(),
    BudgetJudge({ maxMs: 60_000, maxTokens: 6_000 }),
  ],
  cases: loadDataset('summarize-text'),
})
