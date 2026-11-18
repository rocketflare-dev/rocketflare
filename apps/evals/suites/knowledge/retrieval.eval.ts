/**
 * Knowledge retrieval: for every corpus under `datasets/` with a `retrieval.jsonl`, each query runs
 * through the app's own hybrid search and the RANKING is graded — Recall@5, Recall@10 and MRR in
 * code against the answer key's passage text, `ContextPrecision` by the judge over the top 5. No
 * chat model is involved, so a change here is a change to retrieval and nothing else.
 *
 * A measurement suite: `judgeThreshold: null`, so a query that misses is a low score in the
 * report and the baseline, never a failed run. Skips without a real embedder (`evalEmbeddings`).
 */
import { describe, it } from 'vitest'
import { describeEval } from 'vitest-evals'
import {
  ContextPrecision,
  evalEmbeddings,
  judgeHarness,
  listCorpora,
  loadCorpus,
  MRR,
  RecallAtK,
  retrievalHarness,
  skipEvals,
} from '../../kit'

const corpora = listCorpora()
  .map(name => loadCorpus(name))
  .filter(c => c.retrieval.length > 0)
const only = process.env.EVAL_CASE?.split(',').filter(Boolean)
const noEmbedder = () => {
  if (evalEmbeddings()) return false
  console.warn('retrieval evals skipped: no real embedder (EMBEDDINGS_API_KEY or GEMINI_API_KEY)')
  return true
}

if (corpora.length === 0) {
  describe('knowledge · retrieval', () => {
    it.skip('no corpus with a retrieval.jsonl under apps/evals/datasets', () => {})
  })
}

for (const corpus of corpora) {
  const harness = retrievalHarness(corpus)
  for (const query of corpus.retrieval.filter(q => !only?.length || only.includes(q.id))) {
    describeEval(
      'knowledge · retrieval',
      {
        harness,
        judgeHarness,
        judges: [RecallAtK(5), RecallAtK(10), MRR(), ContextPrecision(5)],
        judgeThreshold: null,
        skipIf: () => skipEvals() || noEmbedder(),
      },
      test => {
        test(query.id, async ({ run }) => {
          await run(query)
        })
      }
    )
  }
}
