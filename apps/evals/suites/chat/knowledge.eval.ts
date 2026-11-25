/**
 * Knowledge chat: does the built-in assistant search when it should, stay quiet when it
 * should not, and answer only from what it retrieved? Each case brings its own documents, so the
 * model can only be right for the right reason — or, for a corpus's `chat.jsonl`, asks about the
 * whole corpus, ingested once into a shared tenant (`chatHarness({ corpus })`).
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
  listCorpora,
  loadCorpus,
  loadDataset,
  RubricJudge,
  TrajectoryJudge,
} from '../../kit'

const judges = [TrajectoryJudge('superset'), ContainsJudge(), FaithfulnessJudge(), RubricJudge()]

describeCases('chat · knowledge', {
  harness: chatHarness(),
  judges,
  cases: loadDataset('knowledge-chat'),
})

for (const corpus of listCorpora().map(name => loadCorpus(name))) {
  if (corpus.chat.length === 0) continue
  describeCases('chat · knowledge', {
    harness: chatHarness({ corpus }),
    // A corpus case has no `context` of its own, so Faithfulness would never attach: give it the
    // corpus as the "documents it brings" by attaching the judge unconditionally.
    judges: [
      TrajectoryJudge('superset'),
      ContainsJudge(),
      { ...FaithfulnessJudge(), appliesTo: c => !(c.expected.tools?.length === 0) },
      RubricJudge(),
    ],
    cases: corpus.chat,
  })
}
