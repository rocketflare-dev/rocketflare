/**
 * Chat over planted conflicts, with knowledge facts ON (D43): for every corpus with a
 * `conflicts.jsonl`, the corpus's facts are extracted first (`factsRun`, the same run the
 * `knowledge · facts` suite scores — so the tenant holds the conflicts the system actually caught),
 * then one chat turn per conflicted entity and key (`kit/conflict-chat.ts`), through the real
 * chat route with `lookup_facts` and `search_knowledge`'s facts block on.
 *
 * Judged by `Rubric` alone: the answer gives every value the documents state, each with its
 * source, and says they disagree — the prompt rule "never pick a side silently". The tool the
 * model chose is in the transcript, not scored: either path may answer well.
 *
 * Needs a chat model and a real embedder (entity names are embedded during extraction).
 */
import { describe, it } from 'vitest'
import {
  chatHarness,
  corpusWorld,
  describeCases,
  evalEmbeddings,
  listCorpora,
  loadCorpus,
  RubricJudge,
} from '../../kit'
import { conflictChatCases } from '../../kit/conflict-chat'
import { factsRun } from '../../kit/facts'

const corpora = listCorpora()
  .map(name => loadCorpus(name))
  .filter(c => c.conflicts.length > 0)

if (corpora.length === 0 || !evalEmbeddings()) {
  describe('chat · conflicts', () => {
    it.skip('no corpus with a conflicts.jsonl, or no real embedder', () => {})
  })
} else {
  for (const corpus of corpora) {
    describeCases('chat · conflicts', {
      harness: chatHarness({
        corpus,
        prepare: async () => {
          // The first caller decides which prompt keys a `--model` pins: name both.
          await corpusWorld(corpus, ['chat', 'knowledge-extract'])
          await factsRun(corpus)
        },
      }),
      judges: [RubricJudge()],
      cases: conflictChatCases(corpus),
    })
  }
}
