/**
 * The retrieval target: one query → the app's own `searchKnowledgeChunks`, as the owner of a tenant
 * holding the whole corpus. No model answers anything; the judges grade the RANKING. Recall@k and
 * MRR are computed in code against the answer key's passage text; `ContextPrecision` asks the judge
 * model which of the top passages actually bear on the question.
 */
import {
  createHarness,
  type Harness,
  type JsonValue,
  type Judge,
  type JudgeContext,
} from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { accessScopeForUser } from '@/api/services/access'
import { searchKnowledgeChunks } from '@/api/services/ai/retrieval'
import type { Corpus, RetrievalCase } from './corpus'
import { EVAL_RERANK } from './env'
import { corpusWorld } from './fixtures'
import {
  averagePrecision,
  passageRanks,
  type RankedPassage,
  recallAtK,
  reciprocalRank,
} from './scoring'

/** How many hits a query asks for — the pool every k below is read from. */
export const RETRIEVAL_LIMIT = 20

export interface RetrievalHit extends RankedPassage {
  title: string
  denseRank: number | null
  lexicalRank: number | null
  rerankScore: number | null
}

export function retrievalHarness(corpus: Corpus): Harness<RetrievalCase, JsonValue> {
  return createHarness<RetrievalCase, JsonValue>({
    name: 'rocketflare-retrieval',
    run: async ({ input }) => {
      const world = await corpusWorld(corpus, [])
      const access = await accessScopeForUser(world.db, world.tenantId, world.userId)
      const started = Date.now()
      const { hits, semantic, rerank } = await withEvalScope(() =>
        searchKnowledgeChunks(world.db, world.cfg, world.env, access, {
          query: input.query,
          limit: RETRIEVAL_LIMIT,
          // `--rerank none` measures the fused order; the stub binding's reranker is no reranker.
          rerank: EVAL_RERANK !== 'none',
        })
      )
      const ranked: RetrievalHit[] = hits.map(h => ({
        doc: world.docIdOf.get(h.documentId) ?? h.documentId,
        title: h.title,
        text: h.text,
        denseRank: h.denseRank ?? null,
        lexicalRank: h.lexicalRank ?? null,
        rerankScore: h.rerankScore ?? null,
      }))
      return {
        output: ranked as unknown as JsonValue,
        messages: [{ role: 'user', content: input.query }],
        timings: { totalMs: Date.now() - started },
        usage: {},
        artifacts: {
          semantic,
          rerank: { ...rerank } as unknown as JsonValue,
          ranks: passageRanks(ranked, input.expected),
        },
      }
    },
  })
}

type Ctx = JudgeContext<RetrievalCase, JsonValue>

const hitsOf = (output: JsonValue) =>
  (Array.isArray(output) ? output : []) as unknown as RetrievalHit[]

const ranksOf = (ctx: Ctx) => passageRanks(hitsOf(ctx.output), ctx.input.expected)

/** Share of the expected passages in the top `k` (computed, no judge). */
export const RecallAtK = (k: number): Judge<Ctx> => ({
  name: `Recall@${k}`,
  assess: ctx => {
    const { score, rationale } = recallAtK(ranksOf(ctx), k)
    return { score, metadata: { rationale } }
  },
})

/** 1 / rank of the first expected passage (computed, no judge). */
export const MRR = (): Judge<Ctx> => ({
  name: 'MRR',
  assess: ctx => {
    const { score, rationale } = reciprocalRank(ranksOf(ctx))
    return { score, metadata: { rationale } }
  },
})

const PRECISION_SYSTEM = `You judge search results. For each numbered passage, decide whether it contains information that helps answer the query (even partly). Reply with JSON:
{"relevant": [true|false, …one per passage, in order], "rationale": "<one sentence>"}`

/**
 * The judge's verdict on each of the top `k` passages, scored as average precision — how much of
 * what was retrieved was worth reading, weighted toward the top. Catches what recall cannot: an
 * answer found at #1 under nine passages of noise.
 */
export const ContextPrecision = (k = 5): Judge<Ctx> => ({
  name: 'ContextPrecision',
  assess: async ctx => {
    const top = hitsOf(ctx.output).slice(0, k)
    if (top.length === 0) return { score: 0, metadata: { rationale: 'nothing was retrieved' } }
    if (!ctx.runJudge) return { score: null, metadata: { rationale: 'no judge harness' } }
    const passages = top.map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`).join('\n\n')
    const verdict = (await ctx.runJudge({
      system: PRECISION_SYSTEM,
      prompt: `QUERY\n${ctx.input.query}\n\nPASSAGES\n${passages}`,
      responseFormat: { type: 'json' },
    })) as { relevant?: unknown; rationale?: unknown } | string
    const relevant =
      typeof verdict === 'object' && Array.isArray(verdict.relevant)
        ? top.map((_, i) => (verdict.relevant as unknown[])[i] === true)
        : null
    if (!relevant) throw new Error(`ContextPrecision: judge did not answer a relevant[] list`)
    const { score, rationale } = averagePrecision(relevant)
    return { score, metadata: { rationale, output: verdict as JsonValue } }
  },
})
