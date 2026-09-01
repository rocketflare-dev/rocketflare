/**
 * The kit's built-in agent tools (D7, D18). `search_knowledge` gives every agent read access to
 * the tenant's knowledge base — the same `searchChunks` hybrid search the `/search` page uses,
 * tenant-scoped by the run's `tenantId` (never a model-supplied id). Hits come back as compact
 * JSON (title, document id, rank, fused score, an excerpt) so the model can cite or drill in with
 * `documentId`. A tenant with no embeddings provider gets a plain-text answer, not a crash — the
 * agent decides what to do without knowledge. `get_document` (`get-document.ts`) reads what search
 * found; `buildAgentTools` in `index.ts` is what the runtime puts on `ctx.tools`.
 */
import { SEARCH_MAX_LIMIT } from '@rocketflare/shared/ai/embeddings'
import { z } from 'zod'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { AiNotConfiguredError } from '../../ai/errors'
import type { Tool } from '../../ai/kit'
import { searchChunks } from '../../ai/retrieval'
import type { AiEnv } from '../../ai/types'

export const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge'
/** Excerpt length per hit — enough to answer from, small enough to fit many hits in a turn. */
export const SEARCH_KNOWLEDGE_EXCERPT_CHARS = 1200
/** Hits per call when the model does not say. */
export const SEARCH_KNOWLEDGE_DEFAULT_LIMIT = 5

export const searchKnowledgeInputSchema = z.object({
  query: z.string().trim().min(1).max(2000).describe('What to look for, in natural language'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_LIMIT)
    .optional()
    .describe(`How many passages to return (default ${SEARCH_KNOWLEDGE_DEFAULT_LIMIT})`),
  documentId: z
    .string()
    .uuid()
    .optional()
    .describe('Restrict the search to one document id from an earlier result'),
})
export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>

/** What the tool hands back to the model (JSON-encoded). */
export interface SearchKnowledgeResult {
  query: string
  hits: {
    rank: number
    documentId: string
    title: string
    score: number
    excerpt: string
  }[]
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
      "Search this workspace's knowledge base (documents people uploaded or pasted) for passages relevant to a query. Returns the best-matching passages with their document title and id. Use it before answering questions about the organisation's own material; call again with `documentId` to read more from one document.",
    schema: searchKnowledgeInputSchema,
    async handler(input) {
      try {
        const hits = await searchChunks(ctx.db, ctx.cfg, ctx.env, ctx.tenantId, {
          query: input.query,
          limit: input.limit ?? SEARCH_KNOWLEDGE_DEFAULT_LIMIT,
          documentId: input.documentId,
        })
        const result: SearchKnowledgeResult = {
          query: input.query,
          hits: hits.map(h => ({
            rank: h.rank,
            documentId: h.documentId,
            title: h.title,
            score: Number(h.score.toFixed(4)),
            excerpt:
              h.text.length > SEARCH_KNOWLEDGE_EXCERPT_CHARS
                ? `${h.text.slice(0, SEARCH_KNOWLEDGE_EXCERPT_CHARS)}…`
                : h.text,
          })),
        }
        return JSON.stringify(result)
      } catch (err) {
        if (err instanceof AiNotConfiguredError) {
          return 'Knowledge search is not available: this workspace has no embeddings provider configured. Answer from the input alone and say that the knowledge base could not be consulted.'
        }
        throw err
      }
    },
  }
}
