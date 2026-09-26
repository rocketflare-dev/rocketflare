/**
 * The `research-topic` agent (D33): a tool loop over the knowledge base ending in one
 * `submit_answer`. It must search (`Trajectory`), answer in the declared shape (`Schema`), ground
 * every claim in the passages it read (`Faithfulness` — a run's `tool.end` events keep a
 * 600-character preview per passage, which is what the judge sees), and meet the case's rubric.
 * A run that parks on `ask_human` scores as a miss: an eval cannot answer it.
 */
import { researchTopicOutputSchema } from '@rocketflare/shared/ai/agents'
import {
  agentHarness,
  ContainsJudge,
  describeCases,
  FaithfulnessJudge,
  loadDataset,
  RubricJudge,
  SchemaJudge,
  TrajectoryJudge,
} from '../../kit'

describeCases('agent · research-topic', {
  harness: agentHarness('research-topic'),
  judges: [
    TrajectoryJudge('superset'),
    SchemaJudge(researchTopicOutputSchema),
    ContainsJudge(),
    FaithfulnessJudge(),
    RubricJudge(),
  ],
  cases: loadDataset('research-topic'),
})
