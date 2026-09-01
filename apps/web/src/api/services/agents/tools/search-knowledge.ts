/**
 * `search_knowledge` (D7, D18) — every agent's read access to the tenant's knowledge base: the same
 * hybrid `searchChunks` the `/search` page uses, bound to the run's `tenantId` (never a
 * model-supplied one).
 *
 * The shape of the answer is the whole design here — a model can only reason about what the tool
 * hands back, so:
 *
 * - **Passages come back whole** (up to `PASSAGE_MAX_CHARS`, above the ~3 200-char chunk size)
 *   inside a total `RESPONSE_MAX_CHARS` budget. Truncating every hit to a snippet was the old
 *   behaviour and it starved the model: it saw a third of each passage and had no way to know.
 *   Anything the budget drops is REPORTED (`omitted`), never silently cut.
 * - **Hits are grouped by document and say where in it they sit**: `documentId` and title on the
 *   group, and per passage `passage` (n of `documentPassages`) plus `charOffset` — the exact
 *   `get_document` offset to read around the match. "Read more of this one" is then a mechanical
 *   next call, not a guess, and the model can attribute a claim to a place, not just a file.
 * - **The ranking is nearest-neighbour, not a relevance threshold.** Dense search always returns
 *   the closest passages, so an off-topic query gets the least-unrelated ones rather than nothing.
 *   Every non-empty answer therefore carries `note`, telling the model to judge the text and
 *   discard passages that do not answer the question — the alternative, an arbitrary score cut-off
 *   over an uncalibrated RRF score, would hide good hits as readily as bad ones.
 * - **An empty result is still information**: the answer carries the documents that DO exist
 *   (`knowledgeBase`), so the model re-queries with the right vocabulary instead of concluding the
 *   knowledge base is empty. `list_documents` (`list-documents.ts`) is the same view on demand.
 *
 * `get_document` (`get-document.ts`) reads what search found; `buildAgentTools` in `index.ts` is
 * what the runtime puts on `ctx.tools`.
 */
import { SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import { z } from 'zod'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { AiNotConfiguredError } from '../../ai/errors'
import type { Tool } from '../../ai/kit'
import { searchChunks } from '../../ai/retrieval'
import type { AiEnv } from '../../ai/types'
import { type KnowledgeBaseEntry, listKnowledgeDocuments } from './list-documents'

export const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge'
/**
 * Per passage: a whole ~3 200-char chunk fits, but no more. The budgets below are the compromise
 * between "the model can actually read the material" and "the transcript stays inside a small
 * model's context": the kit's zero-key floor is Workers AI Mistral Small, and a tool result of
 * ~4 000 tokens per turn compounds over a loop until the next call stalls. Raise them for a
 * long-context provider; do not raise them and keep the Workers AI floor.
 */
export const PASSAGE_MAX_CHARS = 3_400
/** Total passage text in one answer (~2 200 tokens) — hits past it are dropped and reported. */
export const RESPONSE_MAX_CHARS = 9_000
/** Passages per call when the model does not say. */
export const SEARCH_KNOWLEDGE_DEFAULT_LIMIT = 8
/** Documents listed back when a search finds nothing, so the model can re-aim. */
export const EMPTY_RESULT_DOCUMENTS = 20

export const searchKnowledgeInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What to look for, in natural language — a question or a phrase, not keywords'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_LIMIT)
    .optional()
    .describe(
      `How many passages to return (default ${SEARCH_KNOWLEDGE_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`
    ),
  documentId: z
    .string()
    .uuid()
    .optional()
    .describe('Search inside ONE document only — a documentId from an earlier result'),
})
export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>

/** One matching passage, whole unless it exceeded `PASSAGE_MAX_CHARS`. */
export interface SearchKnowledgePassage {
  /** 1-based position in the fused ranking (1 = best match). */
  rank: number
  /** Which passage of the document this is, 1-based (`passage of totalPassages`). */
  passage: number
  /** Character offset of this passage in the document — pass it to get_document to read around it. */
  charOffset: number | null
  score: number
  text: string
  /** Set when the passage was longer than the per-passage budget — read the rest with get_document. */
  truncated?: true
}

/** Hits for one document, in rank order. */
export interface SearchKnowledgeDocument {
  documentId: string
  title: string
  /** Passages this document is split into, so `passage 3` reads as "3 of 12". */
  totalPassages: number
  matchingPassages: number
  passages: SearchKnowledgePassage[]
}

/** What the tool hands back to the model (JSON-encoded). */
export interface SearchKnowledgeResult {
  query: string
  /** Documents with at least one matching passage, best match first. */
  documents: SearchKnowledgeDocument[]
  passagesReturned: number
  /** Always present with results: the ranking is nearest-neighbour, so relevance is the model's call. */
  note?: string
  /** Passages that matched but did not fit the answer budget — narrow the query or ask again. */
  omitted?: number
  /** What to do next, in one sentence — present when the result needs a follow-up. */
  hint?: string
  /** Only when nothing matched: what the knowledge base actually holds. */
  knowledgeBase?: KnowledgeBaseEntry[]
}

/** The slice of `AgentContext` the tools need — structural so tests pass `{ db, cfg, env, tenantId }`. */
export interface AgentToolContext {
  db: Database
  cfg: AppConfig
  env: AiEnv
  tenantId: string
}

export function searchKnowledgeTool(ctx: AgentToolContext): Tool<SearchKnowledgeInput> {
  return {
    name: SEARCH_KNOWLEDGE_TOOL,
    description:
      "Search this workspace's knowledge base — everything people uploaded or pasted — and get back the matching PASSAGES in full, grouped by the document they came from and located within it (`passage` n of `totalPassages`, and a `charOffset` you can hand to get_document to read around the match). Results are the CLOSEST passages, not a relevance filter: read them and discard any that do not answer the question, then search again with different wording. Use it before answering any question about the organisation's own material. Narrow to one document with `documentId`, read a whole document with `get_document`, or see what exists with `list_documents`. When nothing matches, the answer lists the documents that do exist so you can re-aim.",
    schema: searchKnowledgeInputSchema,
    async handler(input) {
      let hits: Awaited<ReturnType<typeof searchChunks>>
      try {
        hits = await searchChunks(ctx.db, ctx.cfg, ctx.env, ctx.tenantId, {
          query: input.query,
          limit: input.limit ?? SEARCH_KNOWLEDGE_DEFAULT_LIMIT,
          documentId: input.documentId,
        })
      } catch (err) {
        if (err instanceof AiNotConfiguredError) {
          return JSON.stringify({
            query: input.query,
            error: 'knowledge_search_unavailable',
            hint: 'This workspace has no embeddings provider configured, so the knowledge base cannot be searched. Answer from the information you were given and say the knowledge base could not be consulted.',
          })
        }
        throw err
      }

      // Spend the budget in rank order: a low-ranked passage is dropped whole and counted.
      const byDocument = new Map<string, SearchKnowledgeDocument>()
      let spent = 0
      let omitted = 0
      let passagesReturned = 0
      for (const hit of hits) {
        const truncated = hit.text.length > PASSAGE_MAX_CHARS
        const text = truncated ? `${hit.text.slice(0, PASSAGE_MAX_CHARS)}…` : hit.text
        if (spent + text.length > RESPONSE_MAX_CHARS && passagesReturned > 0) {
          omitted += 1
          continue
        }
        spent += text.length
        passagesReturned += 1
        const doc = byDocument.get(hit.documentId) ?? {
          documentId: hit.documentId,
          title: hit.title,
          totalPassages: hit.documentPassages,
          matchingPassages: 0,
          passages: [],
        }
        doc.matchingPassages += 1
        doc.passages.push({
          rank: hit.rank,
          passage: hit.seq + 1,
          charOffset: hit.charOffset,
          score: Number(hit.score.toFixed(4)),
          text,
          ...(truncated ? { truncated: true as const } : {}),
        })
        byDocument.set(hit.documentId, doc)
      }

      const result: SearchKnowledgeResult = {
        query: input.query,
        documents: [...byDocument.values()],
        passagesReturned,
      }
      if (passagesReturned > 0) {
        result.note =
          'These are the closest passages to the query, not a relevance filter — read them and ignore any that do not answer the question. If none do, search again with different wording before concluding the knowledge base does not cover it.'
      }
      if (omitted > 0) {
        result.omitted = omitted
        result.hint = `${omitted} further passage(s) matched but did not fit this answer — ask a narrower question, or read a document from its passage's charOffset with get_document.`
      }
      const cut = [...byDocument.values()].flatMap(d => d.passages).some(p => p.truncated)
      if (cut && !result.hint) {
        result.hint =
          'A passage was longer than the budget and was cut — read the rest with get_document at its charOffset.'
      }
      if (passagesReturned === 0) {
        const knowledgeBase = await listKnowledgeDocuments(ctx, { limit: EMPTY_RESULT_DOCUMENTS })
        result.knowledgeBase = knowledgeBase.documents
        result.hint =
          knowledgeBase.total === 0
            ? 'The knowledge base is empty — nothing has been indexed for this workspace. Say so rather than answering from general knowledge.'
            : 'Nothing matched. Try the wording used in the document titles listed here, a broader phrase, or read a likely document with get_document.'
      }
      return JSON.stringify(result)
    },
  }
}
