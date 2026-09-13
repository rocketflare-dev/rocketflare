/**
 * `get_document` (D7, D18): read one knowledge document's text, whole or a window of it. The
 * companion of `search_knowledge` — search finds the passage, this reads around it or the full
 * text. Windows are character offsets over the stored `content` (pasted text, or the converted
 * markdown of an upload), capped per call so a 500 000-char document is paged, never dumped into
 * one turn; the answer says how much is left and where to continue. **The cap belongs to the
 * CALLER, not the tool** (`AgentToolContext.maxDocumentChars`): an agent run may read 50 000
 * characters because reading the document is the job, while a chat turn gets
 * `CHAT_GET_DOCUMENT_MAX_CHARS` because it shares one context window with the whole thread.
 * Tenant-scoped by the run's
 * `tenantId`; another tenant's id, an unknown id or a not-yet-converted upload each get a plain
 * answer rather than an error.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { documents } from '../../../../db/schema'
import type { Tool } from '../../ai/kit'
import { type KnowledgeBaseEntry, listKnowledgeDocuments } from './list-documents'
import type { AgentToolContext } from './search-knowledge'

/** Documents offered back when the model names one that does not exist. */
const SUGGEST_DOCUMENTS = 20

export const GET_DOCUMENT_TOOL = 'get_document'
/** Characters per call when the model does not say (~5 000 tokens at 4 chars per token). */
export const GET_DOCUMENT_DEFAULT_CHARS = 20_000
/** The ceiling for an AGENT RUN, where reading a document IS the job (~12 500 tokens). */
export const GET_DOCUMENT_MAX_CHARS = 50_000
/**
 * The ceiling for a CHAT turn (~1 500 tokens). One number cannot serve both: an agent run gets a
 * Workflow step to itself, while a chat turn shares one context window with the thread's history
 * and every later turn — 50 000 characters there is most of a small model's window spent on one
 * tool result, which is how a thread poisons its own next turn. Sized against `RESPONSE_MAX_CHARS`
 * in `search-knowledge.ts`, and a quarter of the default `CHAT_HISTORY_MAX_CHARS`, so a window plus
 * the history still fits.
 */
export const CHAT_GET_DOCUMENT_MAX_CHARS = 6_000

/**
 * The schema the model is shown. `maxChars`' upper bound is the CALLER's cap so the bound is
 * declared rather than discovered — but an over-ask is clamped by the handler, never rejected: a
 * validation error costs a turn the model usually cannot diagnose, while a short answer that says
 * `hasMore` and `nextOffset` is a next call it already knows how to make.
 */
export function getDocumentSchema(maxChars = GET_DOCUMENT_MAX_CHARS) {
  return z.object({
    documentId: z.string().uuid().describe('The document id (from search_knowledge or the user)'),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character offset to start from (default 0 = the beginning)'),
    maxChars: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `How many characters to return at most (default and maximum ${maxChars}; a larger request is trimmed to it)`
      ),
  })
}

export const getDocumentInputSchema = getDocumentSchema()
export type GetDocumentInput = z.infer<typeof getDocumentInputSchema>

/** What the tool hands back to the model (JSON-encoded). */
export interface GetDocumentResult {
  documentId: string
  title: string
  source: string | null
  contentType: string
  status: string
  totalChars: number
  /** Passages the document was split into — how many `search_knowledge` could match. */
  passages: number
  offset: number
  returnedChars: number
  text: string
  /** `true` when `offset + text.length < totalChars` — call again with `nextOffset`. */
  hasMore: boolean
  nextOffset: number | null
  /** What to do next, in one sentence — present when there is more to read. */
  hint?: string
}

/** An answer the model can act on: why it got no text, and what it could ask for instead. */
export interface GetDocumentProblem {
  documentId: string
  error: 'document_not_found' | 'not_yet_converted' | 'conversion_failed'
  hint: string
  /** Only for `document_not_found`: the documents that DO exist. */
  knowledgeBase?: KnowledgeBaseEntry[]
}

export function getDocumentTool(ctx: AgentToolContext): Tool<GetDocumentInput> {
  // The window one call may return, capped by the caller (chat asks for far less than an agent run).
  const cap = Math.min(ctx.maxDocumentChars ?? GET_DOCUMENT_MAX_CHARS, GET_DOCUMENT_MAX_CHARS)
  const fallback = Math.min(GET_DOCUMENT_DEFAULT_CHARS, cap)
  return {
    name: GET_DOCUMENT_TOOL,
    description: `Read one knowledge-base document's text, whole or in windows: \`offset\` and \`maxChars\` select a character range (default and maximum ${cap} characters, from the start; the answer reports \`totalChars\`, \`hasMore\` and \`nextOffset\`, so a long document is read by calling again with \`nextOffset\` until \`hasMore\` is false). Use it after search_knowledge when a passage is cut off or you need the surrounding context, or on any id from list_documents. An unknown id answers with the documents that do exist.`,
    schema: getDocumentSchema(cap),
    async handler(input) {
      const row = await ctx.db.query.documents.findFirst({
        where: and(eq(documents.id, input.documentId), eq(documents.tenantId, ctx.tenantId)),
      })
      if (!row) {
        const knowledgeBase = await listKnowledgeDocuments(ctx, { limit: SUGGEST_DOCUMENTS })
        const problem: GetDocumentProblem = {
          documentId: input.documentId,
          error: 'document_not_found',
          hint: knowledgeBase.total
            ? 'No document with that id exists in this workspace. Pick one of the documents listed here, or search again.'
            : 'The knowledge base is empty — nothing has been indexed for this workspace.',
          knowledgeBase: knowledgeBase.documents,
        }
        return JSON.stringify(problem)
      }
      if (row.content === null) {
        const problem: GetDocumentProblem = {
          documentId: row.id,
          error: row.status === 'failed' ? 'conversion_failed' : 'not_yet_converted',
          hint:
            row.status === 'failed'
              ? `"${row.title}" could not be indexed (${row.error ?? 'unknown error'}), so its text is not available. Use another document.`
              : `"${row.title}" is still being converted and has no text yet. Use another document or answer without it.`,
        }
        return JSON.stringify(problem)
      }
      const content = row.content
      const offset = Math.min(input.offset ?? 0, content.length)
      // Clamped, not refused: an over-ask becomes a shorter window plus `hasMore`/`nextOffset`.
      const want = Math.min(input.maxChars ?? fallback, cap)
      const text = content.slice(offset, offset + want)
      const end = offset + text.length
      const result: GetDocumentResult = {
        documentId: row.id,
        title: row.title,
        source: row.source,
        contentType: row.contentType,
        status: row.status,
        totalChars: content.length,
        passages: row.chunkCount,
        offset,
        returnedChars: text.length,
        text,
        hasMore: end < content.length,
        nextOffset: end < content.length ? end : null,
      }
      if (result.hasMore) {
        result.hint = `${content.length - end} characters remain — call again with offset ${end} to continue.`
      }
      return JSON.stringify(result)
    },
  }
}
