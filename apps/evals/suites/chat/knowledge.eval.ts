/**
 * Knowledge chat (D33): does the built-in assistant search when it should, stay quiet when it
 * should not, and answer only from what it retrieved? Each case brings its own documents, so the
 * model can only be right for the right reason.
 *
 * Judges: `Trajectory` (did it call `search_knowledge` — or, for a greeting, nothing), `Contains`
 * (the fact that must appear), `Faithfulness` (every claim supported by the passages it was shown)
 * and `Rubric` (the case's plain-language criteria). Each case gets the ones it declares something
 * for (`describeCases`).
 */
import {
  ContainsJudge,
  chatHarness,
  describeCases,
  FaithfulnessJudge,
  loadDataset,
  RubricJudge,
  TrajectoryJudge,
} from '../../kit'

describeCases('chat · knowledge', {
  harness: chatHarness(),
  judges: [TrajectoryJudge('superset'), ContainsJudge(), FaithfulnessJudge(), RubricJudge()],
  cases: loadDataset('knowledge-chat'),
})
