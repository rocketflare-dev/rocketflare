/**
 * Knowledge facts (D43): for every corpus with a `facts.jsonl`, every document is extracted — in
 * date order, through the app's own `knowledge.extract` job body, with the REAL model — and what
 * landed in `knowledge_facts` is scored against the answer keys (`kit/facts.ts`):
 *
 * - one case per document: `Precision` / `Recall` of its facts;
 * - `facts-all`: the same over the whole corpus (the plan's exit: precision ≥ 0.9, recall ≥ 0.7);
 * - `conflicts`: `ConflictsCaught` (≥ 0.8), `NoFalseAlarms` (1 − the false-alarm rate, ≥ 0.9) and
 *   `WinnerAccuracy` — does the side an answer leads with match the planted winner?
 *
 * A measurement suite: `judgeThreshold: null`, so a low score is a number in the report and the
 * baseline, never a failed run. Needs a chat model and a real embedder (entity names are embedded).
 */
import { describe, it } from 'vitest'
import { describeEval } from 'vitest-evals'
import { evalEmbeddings, judgeHarness, listCorpora, loadCorpus, skipEvals } from '../../kit'
import {
  ConflictsCaught,
  type FactsCase,
  factsHarness,
  NoFalseAlarms,
  Precision,
  Recall,
  WinnerAccuracy,
} from '../../kit/facts'

const corpora = listCorpora()
  .map(name => loadCorpus(name))
  .filter(c => c.facts.length > 0)
const only = process.env.EVAL_CASE?.split(',').filter(Boolean)
const noEmbedder = () => {
  if (evalEmbeddings()) return false
  console.warn('facts evals skipped: no real embedder (EMBEDDINGS_API_KEY or GEMINI_API_KEY)')
  return true
}

if (corpora.length === 0) {
  describe('knowledge · facts', () => {
    it.skip('no corpus with a facts.jsonl under apps/evals/datasets', () => {})
  })
}

for (const corpus of corpora) {
  const harness = factsHarness(corpus)
  const docs = [...new Set(corpus.facts.map(f => f.doc))].sort()
  const cases: FactsCase[] = [
    ...docs.map(doc => ({ id: `${corpus.name}:${doc}`, kind: 'doc' as const, doc })),
    // Documents with no planted fact still count: whatever is extracted from them is spurious.
    ...corpus.docs
      .filter(d => !docs.includes(d.id))
      .map(d => ({ id: `${corpus.name}:${d.id}`, kind: 'doc' as const, doc: d.id })),
    { id: `${corpus.name}:facts-all`, kind: 'all' },
    { id: `${corpus.name}:conflicts`, kind: 'conflicts' },
  ]
  for (const c of cases.filter(c => !only?.length || only.includes(c.id))) {
    describeEval(
      'knowledge · facts',
      {
        harness,
        judgeHarness,
        judges:
          c.kind === 'conflicts'
            ? [ConflictsCaught(), NoFalseAlarms(), WinnerAccuracy()]
            : [Precision(), Recall()],
        judgeThreshold: null,
        skipIf: () => skipEvals() || noEmbedder(),
      },
      test => {
        test(c.id, async ({ run }) => {
          await run(c)
        })
      }
    )
  }
}
