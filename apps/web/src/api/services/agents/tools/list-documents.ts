/**
 * `list_documents` (D7, D18) — what is actually IN the knowledge base. Search answers "which
 * passages match these words"; this answers "what material exists at all", which is what a model
 * needs before it can pick good search terms, and what it needs to say honestly that a topic is not
 * covered. `search_knowledge` reuses `listKnowledgeDocuments` to attach the same view to an empty
 * result, and `get_document` to an unknown id, so the agent is never left guessing.
 *
 * Only indexed documents are listed: a `pending` upload is still converting and its text cannot be
 * searched or read yet, so offering it would only produce a failed follow-up call.
 */
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { documents } from '../../../../db/schema'
import type { Tool } from '../../ai/kit'
import type { AgentToolContext } from './search-knowledge'

export const LIST_DOCUMENTS_TOOL = 'list_documents'
export const LIST_DOCUMENTS_DEFAULT_LIMIT = 25
export const LIST_DOCUMENTS_MAX_LIMIT = 100

export const listDocumentsInputSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_DOCUMENTS_MAX_LIMIT)
    .optional()
    .describe(
      `How many documents to list (default ${LIST_DOCUMENTS_DEFAULT_LIMIT}, max ${LIST_DOCUMENTS_MAX_LIMIT}), newest first`
    ),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Skip this many documents — page through with `nextOffset` from the last answer'),
})
export type ListDocumentsInput = z.infer<typeof listDocumentsInputSchema>

/** One document as the model sees it — enough to decide whether to read or search it. */
export interface KnowledgeBaseEntry {
  documentId: string
  title: string
  source: string | null
  contentType: string
  /** Characters of extracted text — how much `get_document` can return. */
  totalChars: number
  /** Passages it was split into; each one is a possible `search_knowledge` hit. */
  passages: number
  addedAt: string
}

export interface ListDocumentsResult {
  /** Indexed documents in this workspace (the only ones that are searchable/readable). */
  total: number
  documents: KnowledgeBaseEntry[]
  hasMore: boolean
  nextOffset: number | null
  hint?: string
}

/** The shared query behind the tool, an empty search result and an unknown-document answer. */
export async function listKnowledgeDocuments(
  ctx: AgentToolContext,
  input: ListDocumentsInput = {}
): Promise<ListDocumentsResult> {
  const limit = input.limit ?? LIST_DOCUMENTS_DEFAULT_LIMIT
  const offset = input.offset ?? 0
  const where = and(eq(documents.tenantId, ctx.tenantId), eq(documents.status, 'indexed'))
  const [rows, total] = await Promise.all([
    ctx.db
      .select({
        id: documents.id,
        title: documents.title,
        source: documents.source,
        contentType: documents.contentType,
        content: documents.content,
        chunkCount: documents.chunkCount,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(where)
      .orderBy(desc(documents.createdAt))
      .limit(limit)
      .offset(offset),
    ctx.db.$count(documents, where),
  ])
  const listed = rows.map(row => ({
    documentId: row.id,
    title: row.title,
    source: row.source,
    contentType: row.contentType,
    totalChars: row.content?.length ?? 0,
    passages: row.chunkCount,
    addedAt: row.createdAt.toISOString(),
  }))
  const hasMore = offset + listed.length < total
  return {
    total,
    documents: listed,
    hasMore,
    nextOffset: hasMore ? offset + listed.length : null,
  }
}

export function listDocumentsTool(ctx: AgentToolContext): Tool<ListDocumentsInput> {
  return {
    name: LIST_DOCUMENTS_TOOL,
    description:
      "List the documents in this workspace's knowledge base, newest first, with their titles, ids and sizes. Call it when you need to know what material exists — to choose search wording, to pick a document to read in full with `get_document`, or to state honestly that a topic is not covered. Only indexed (searchable) documents are listed.",
    schema: listDocumentsInputSchema,
    async handler(input) {
      const result = await listKnowledgeDocuments(ctx, input)
      if (result.total === 0) {
        result.hint =
          'The knowledge base is empty — nothing has been indexed for this workspace. Say so rather than answering from general knowledge.'
      } else if (result.hasMore) {
        result.hint = `Showing ${result.documents.length} of ${result.total}. Call again with offset ${result.nextOffset} for more.`
      }
      return JSON.stringify(result)
    },
  }
}
