/**
 * `get_document` (D7, D18): read one knowledge document's text, whole or a window of it. The
 * companion of `search_knowledge` — search finds the passage, this reads around it or the full
 * text. Windows are character offsets over the stored `content` (pasted text, or the converted
 * markdown of an upload), capped per call so a 500 000-char document is paged, never dumped into
 * one turn; the answer says how much is left and where to continue. Tenant-scoped by the run's
 * `tenantId`; another tenant's id, an unknown id or a not-yet-converted upload each get a plain
 * answer rather than an error.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { documents } from '../../../../db/schema'
import type { Tool } from '../../ai/kit'
import type { AgentToolContext } from './search-knowledge'

export const GET_DOCUMENT_TOOL = 'get_document'
/** Default and hard cap on characters per call (~5 000 / ~12 000 tokens at 4 chars per token). */
export const GET_DOCUMENT_DEFAULT_CHARS = 20_000
export const GET_DOCUMENT_MAX_CHARS = 50_000

export const getDocumentInputSchema = z.object({
  documentId: z.string().uuid().describe('The document id (from search_knowledge or the user)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset to start from (default 0 = the beginning)'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(GET_DOCUMENT_MAX_CHARS)
    .optional()
    .describe(`How many characters to return at most (default ${GET_DOCUMENT_DEFAULT_CHARS})`),
})
export type GetDocumentInput = z.infer<typeof getDocumentInputSchema>

/** What the tool hands back to the model (JSON-encoded). */
export interface GetDocumentResult {
  documentId: string
  title: string
  source: string | null
  contentType: string
  status: string
  totalChars: number
  offset: number
  text: string
  /** `true` when `offset + text.length < totalChars` — call again with `nextOffset`. */
  hasMore: boolean
  nextOffset: number | null
}

export function getDocumentTool(ctx: AgentToolContext): Tool<GetDocumentInput> {
  return {
    name: GET_DOCUMENT_TOOL,
    description:
      'Read the text of one knowledge-base document, in full or a part of it: `offset` and `maxChars` select a character window (the answer reports `totalChars`, `hasMore` and `nextOffset` for paging). Use it after search_knowledge to read the whole passage or the whole document.',
    schema: getDocumentInputSchema,
    async handler(input) {
      const row = await ctx.db.query.documents.findFirst({
        where: and(eq(documents.id, input.documentId), eq(documents.tenantId, ctx.tenantId)),
      })
      if (!row) return `No document with id ${input.documentId} exists in this workspace.`
      if (row.content === null) {
        return row.status === 'failed'
          ? `Document "${row.title}" could not be indexed (${row.error ?? 'unknown error'}); its text is not available.`
          : `Document "${row.title}" is still being converted; its text is not available yet. Try again later.`
      }
      const content = row.content
      const offset = Math.min(input.offset ?? 0, content.length)
      const text = content.slice(offset, offset + (input.maxChars ?? GET_DOCUMENT_DEFAULT_CHARS))
      const end = offset + text.length
      const result: GetDocumentResult = {
        documentId: row.id,
        title: row.title,
        source: row.source,
        contentType: row.contentType,
        status: row.status,
        totalChars: content.length,
        offset,
        text,
        hasMore: end < content.length,
        nextOffset: end < content.length ? end : null,
      }
      return JSON.stringify(result)
    },
  }
}
