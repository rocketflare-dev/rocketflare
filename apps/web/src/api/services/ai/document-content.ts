/**
 * Reading a knowledge document (D18) — the ONE implementation behind three callers: the
 * `get_document` agent tool, `GET /api/ai/documents/:id/content|passages|card`, and the document
 * viewer. Before this existed the tool sliced the text in JS, which meant pulling a 500 000-char
 * `content` column into the isolate to return 20 000 of it; every window here is cut in Postgres
 * (`substring(content from :offset+1 for :maxChars)` + `char_length`), so the bytes crossing the
 * wire are the bytes asked for.
 *
 * Every query carries the tenant predicate. An unknown id and another tenant's id are the SAME
 * answer (`document_not_found`) so the API is not an existence oracle. The failure branch carries
 * `title` and `error` because the tool builds a sentence out of them.
 */
import {
  DOCUMENT_EXCERPT_CHARS,
  DOCUMENT_WINDOW_CHARS,
  DOCUMENT_WINDOW_MAX_CHARS,
  type DocumentCard,
  type DocumentContent,
  type DocumentPassage,
  type DocumentStatus,
  documentPath,
  documentTypeLabel,
} from '@rocketflare/shared/ai/embeddings'
import type { PaginationQuery } from '@rocketflare/shared/pagination'
import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { chunks, documents } from '../../../db/schema'
import { pageWindow } from '../../utils/routes/pagination'
import { chunkCharOffsetSql } from './retrieval'

export interface ReadDocumentWindowInput {
  documentId: string
  offset?: number
  maxChars?: number
}

/** Why a document has no text to return — the three shapes `get_document` has always reported. */
export type DocumentContentProblem =
  | 'document_not_found'
  | 'not_yet_converted'
  | 'conversion_failed'

export type ReadDocumentWindowResult =
  | { ok: true; content: DocumentContent }
  | {
      ok: false
      reason: DocumentContentProblem
      /** The document's title — null when it does not exist. */
      title: string | null
      /** `documents.error` for a failed conversion. */
      error: string | null
    }

/**
 * A character window over one document's text. `offset` is clamped to the document's length and
 * `maxChars` to `DOCUMENT_WINDOW_MAX_CHARS` (or a lower caller cap): an over-ask is trimmed, never
 * refused — a short window that reports `hasMore` and `nextOffset` is a call the caller (or a
 * model) already knows how to make, while an error costs a turn nobody can diagnose.
 */
export async function readDocumentWindow(
  db: Database,
  tenantId: string,
  input: ReadDocumentWindowInput,
  cap = DOCUMENT_WINDOW_MAX_CHARS
): Promise<ReadDocumentWindowResult> {
  const limit = Math.max(1, Math.min(cap, DOCUMENT_WINDOW_MAX_CHARS))
  const want = Math.max(
    1,
    Math.min(input.maxChars ?? Math.min(DOCUMENT_WINDOW_CHARS, limit), limit)
  )
  const requested = Math.max(0, Math.trunc(input.offset ?? 0))
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      source: documents.source,
      contentType: documents.contentType,
      status: documents.status,
      passages: documents.chunkCount,
      error: documents.error,
      hasContent: sql<boolean>`${documents.content} is not null`,
      // Sliced in Postgres: `substring` is 1-based, and `char_length` counts characters, not bytes.
      totalChars: sql<number>`coalesce(char_length(${documents.content}), 0)`,
      // The parameters need explicit casts: in `substring(… from … for …)` Postgres cannot infer
      // their type from context and rejects the statement outright.
      text: sql<string>`coalesce(substring(${documents.content} from ${requested + 1}::int for ${want}::int), '')`,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, tenantId)))
    .limit(1)

  if (!row) return { ok: false, reason: 'document_not_found', title: null, error: null }
  if (!row.hasContent) {
    return {
      ok: false,
      reason: row.status === 'failed' ? 'conversion_failed' : 'not_yet_converted',
      title: row.title,
      error: row.error,
    }
  }
  const totalChars = Number(row.totalChars)
  const offset = Math.min(requested, totalChars)
  const text = row.text
  const end = offset + text.length
  return {
    ok: true,
    content: {
      documentId: row.id,
      title: row.title,
      source: row.source,
      contentType: row.contentType,
      status: row.status as DocumentStatus,
      totalChars,
      passages: row.passages,
      offset,
      returnedChars: text.length,
      text,
      hasMore: end < totalChars,
      nextOffset: end < totalChars ? end : null,
    },
  }
}

/**
 * The document's passages in `seq` order, paginated. The select names its columns so
 * `chunks.embedding` can never reach the wire through a later widening — 1024 floats per row would
 * be the whole response. `charOffset` shares `chunkCharOffsetSql` with `locateChunks`, so a search
 * hit and this list cannot disagree about where a passage sits. `null` when the document does not
 * exist in this tenant.
 */
export async function listDocumentPassages(
  db: Database,
  tenantId: string,
  documentId: string,
  query: PaginationQuery
): Promise<{ items: DocumentPassage[]; total: number } | null> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
    .limit(1)
  if (!doc) return null
  const { limit, offset } = pageWindow(query)
  const where = and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId))
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: chunks.id,
        documentId: chunks.documentId,
        seq: chunks.seq,
        tokenCount: chunks.tokenCount,
        charOffset: chunkCharOffsetSql,
        text: chunks.text,
      })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(where)
      .orderBy(asc(chunks.seq))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(chunks).where(where),
  ])
  return {
    items: rows.map(row => ({
      id: row.id,
      documentId: row.documentId,
      seq: row.seq,
      tokenCount: row.tokenCount,
      // `position()` is 1-based and 0 when the passage cannot be located (re-chunked since).
      charOffset: Number(row.charOffset) > 0 ? Number(row.charOffset) - 1 : null,
      text: row.text,
    })),
    total: total?.n ?? 0,
  }
}

/**
 * The card one document renders as anywhere it is cited. `excerpt` is the head of the text, NOT a
 * summary: there is no `documents.summary` column and no rasterisation on Workers, so this is what
 * an honest preview can be. `null` while the document is `pending` or `failed`.
 */
export async function readDocumentCard(
  db: Database,
  tenantId: string,
  documentId: string
): Promise<DocumentCard | null> {
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      contentType: documents.contentType,
      status: documents.status,
      passages: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      fileId: documents.fileId,
      // Read a little more than the excerpt needs: collapsing whitespace only ever shortens it.
      head: sql<
        string | null
      >`substring(${documents.content} from 1 for ${DOCUMENT_EXCERPT_CHARS * 4}::int)`,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    typeLabel: documentTypeLabel(row.contentType),
    contentType: row.contentType,
    status: row.status as DocumentStatus,
    excerpt: documentExcerpt(row.head, DOCUMENT_EXCERPT_CHARS),
    passages: row.passages,
    sizeBytes: row.sizeBytes,
    fileId: row.fileId,
    href: documentPath(row.id),
  }
}

/** Whitespace-collapsed head of a text, ellipsised. Pure; `null` in, `null` out. */
export function documentExcerpt(
  text: string | null | undefined,
  max = DOCUMENT_EXCERPT_CHARS
): string | null {
  if (!text) return null
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`
}
