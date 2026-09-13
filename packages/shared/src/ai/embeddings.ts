/**
 * Embeddings / retrieval contracts (D17, D18): the `documents` row the API returns (never the raw
 * text or vectors), the text-ingest request, and the hybrid search request/response. Retrieval
 * ships WITH this ingest path so `searchChunks` is never dead code (00 §1.3). File uploads
 * (`POST /upload`, multipart) share the same `documents` row: the allowlist below is what the UI's
 * `<input accept>` offers and what the route answers 415 to.
 */
import { z } from 'zod'
import { paginationQuerySchema } from '../pagination'

export const documentStatusSchema = z.enum(['pending', 'indexed', 'failed'])
export type DocumentStatus = z.infer<typeof documentStatusSchema>

export const documentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable(),
  title: z.string(),
  /** Where the text came from: `upload`, `agent:summarize-text`, a URL … free text. */
  source: z.string().nullable(),
  /** The ORIGINAL media type: `text/plain` for pasted text, `application/pdf` for an uploaded PDF … */
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** The `files` row holding the uploaded original (download at `filePath(fileId)`), null for pasted text. */
  fileId: z.string().uuid().nullable(),
  chunkCount: z.number().int().nonnegative(),
  status: documentStatusSchema,
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Document = z.infer<typeof documentSchema>

/** Longest text `POST /api/ai/documents/ingest` accepts (characters; ~ the 1 MB JSON body cap). */
export const INGEST_TEXT_MAX_CHARS = 500_000

export const ingestTextRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(INGEST_TEXT_MAX_CHARS),
  source: z.string().trim().min(1).max(200).optional(),
})
export type IngestTextRequest = z.infer<typeof ingestTextRequestSchema>

export const documentListQuerySchema = paginationQuerySchema.extend({
  status: documentStatusSchema.optional(),
})
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

export const SEARCH_MAX_LIMIT = 20

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(10),
  /** Restrict to one document. */
  documentId: z.string().uuid().optional(),
})
export type SearchRequest = z.infer<typeof searchRequestSchema>

export const searchHitSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  title: z.string(),
  text: z.string(),
  /** The passage's position in its document, from 0 ("passage seq+1 of documentPassages"). */
  seq: z.number().int().nonnegative(),
  /** How many passages the document has in total. */
  documentPassages: z.number().int().nonnegative(),
  /**
   * Character offset of the passage in the document's text — read around it with
   * `GET`/`get_document` at this offset. Null when it cannot be located (re-chunked since).
   */
  charOffset: z.number().int().nonnegative().nullable(),
  /** Reciprocal-rank-fusion score — higher is better; NOT a cosine similarity. */
  score: z.number(),
  /** 1-based position in the fused order. */
  rank: z.number().int().positive(),
  /** Which signal(s) found it: 1-based rank in that list, or null. */
  denseRank: z.number().int().positive().nullable(),
  lexicalRank: z.number().int().positive().nullable(),
})
export type SearchHit = z.infer<typeof searchHitSchema>

export const searchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
})
export type SearchResponse = z.infer<typeof searchResponseSchema>

// ---- File upload -----------------------------------------------------------------------------

/**
 * What `POST /api/ai/documents/upload` accepts. `text` types are decoded as UTF-8 and indexed like
 * pasted text; `convert` types go through Workers AI Markdown Conversion (`env.AI.toMarkdown`) in
 * the `document.convert` job. Images are deliberately absent: their conversion runs two AI models
 * and bills, and OCR is not a v1 promise. Extend per app.
 */
export const DOCUMENT_UPLOAD_TYPES = {
  'text/plain': { extensions: ['.txt', '.text'], kind: 'text', label: 'Text' },
  'text/markdown': { extensions: ['.md', '.markdown'], kind: 'text', label: 'Markdown' },
  'text/csv': { extensions: ['.csv'], kind: 'text', label: 'CSV' },
  'application/json': { extensions: ['.json'], kind: 'text', label: 'JSON' },
  'application/pdf': { extensions: ['.pdf'], kind: 'convert', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['.docx'],
    kind: 'convert',
    label: 'Word',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['.xlsx'],
    kind: 'convert',
    label: 'Excel',
  },
  'application/vnd.ms-excel': { extensions: ['.xls'], kind: 'convert', label: 'Excel' },
  'application/vnd.oasis.opendocument.text': {
    extensions: ['.odt'],
    kind: 'convert',
    label: 'OpenDocument',
  },
  'application/vnd.oasis.opendocument.spreadsheet': {
    extensions: ['.ods'],
    kind: 'convert',
    label: 'OpenDocument',
  },
  'text/html': { extensions: ['.html', '.htm'], kind: 'convert', label: 'HTML' },
  'application/xml': { extensions: ['.xml'], kind: 'convert', label: 'XML' },
} as const satisfies Record<
  string,
  { extensions: readonly string[]; kind: 'text' | 'convert'; label: string }
>

export type DocumentUploadMimeType = keyof typeof DOCUMENT_UPLOAD_TYPES
export type DocumentUploadKind = (typeof DOCUMENT_UPLOAD_TYPES)[DocumentUploadMimeType]['kind']

export interface DocumentUploadType {
  contentType: DocumentUploadMimeType
  kind: DocumentUploadKind
  label: string
}

/** Every extension in the allowlist — the `<input accept>` value. */
export const DOCUMENT_UPLOAD_ACCEPT = Object.values(DOCUMENT_UPLOAD_TYPES)
  .flatMap(t => t.extensions)
  .join(',')

export function isDocumentUploadMimeType(type: string): type is DocumentUploadMimeType {
  return Object.hasOwn(DOCUMENT_UPLOAD_TYPES, type)
}

/** Declared types a browser sends when it does not know better — fall back to the extension. */
const UNKNOWN_TYPES = new Set(['', 'application/octet-stream'])

/** `text/xml` is how some browsers declare `.xml`; the converter wants `application/xml`. */
const TYPE_ALIASES: Record<string, DocumentUploadMimeType> = {
  'text/xml': 'application/xml',
  'application/x-markdown': 'text/markdown',
}

/**
 * Resolve the accepted media type of an upload from the client's declared `Content-Type` and the
 * filename. Browsers send `''` for `.md` and `application/octet-stream` for anything unfamiliar,
 * so the extension decides in those cases; a declared type must otherwise be on the allowlist.
 * `null` = not accepted (the route answers 415).
 */
export function resolveDocumentUploadType(
  filename: string,
  declaredType: string | null | undefined
): DocumentUploadType | null {
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const aliased = TYPE_ALIASES[declared] ?? declared
  if (!UNKNOWN_TYPES.has(aliased)) {
    if (!isDocumentUploadMimeType(aliased)) return null
    const entry = DOCUMENT_UPLOAD_TYPES[aliased]
    return { contentType: aliased, kind: entry.kind, label: entry.label }
  }
  const dot = filename.lastIndexOf('.')
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : ''
  for (const [contentType, entry] of Object.entries(DOCUMENT_UPLOAD_TYPES)) {
    if ((entry.extensions as readonly string[]).includes(ext)) {
      return {
        contentType: contentType as DocumentUploadMimeType,
        kind: entry.kind,
        label: entry.label,
      }
    }
  }
  return null
}

/** The label the UI shows for a document's `contentType` (`PDF`, `Markdown`, …); `Text` when unknown. */
export function documentTypeLabel(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return isDocumentUploadMimeType(base) ? DOCUMENT_UPLOAD_TYPES[base].label : 'Text'
}

/** The text fields of the multipart upload body (`file` is the third part, validated by the route). */
export const uploadDocumentFieldsSchema = z.object({
  /** Defaults to the filename without its extension. */
  title: z.string().trim().min(1).max(200).optional(),
  /** Defaults to the sanitised filename. */
  source: z.string().trim().min(1).max(200).optional(),
})
export type UploadDocumentFields = z.infer<typeof uploadDocumentFieldsSchema>

/** Client-side mirror of the route's 415/413/400 — a message to show, or null when acceptable. */
export function validateDocumentFile(
  file: { name: string; type: string; size: number },
  maxBytes: number
): string | null {
  if (!resolveDocumentUploadType(file.name, file.type)) {
    return 'Choose a PDF, Word, Excel, OpenDocument, HTML, XML, CSV, JSON, Markdown or text file'
  }
  if (file.size === 0) return 'That file is empty'
  if (file.size > maxBytes) {
    return `Files must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller`
  }
  return null
}

// ---- Reading a document ------------------------------------------------------------------------

/**
 * `GET /api/ai/documents/:id/content?offset=&maxChars=` — a character window over the document's
 * text (pasted text, or the converted markdown of an upload). The same shape the `get_document`
 * agent tool returns, minus its `hint`: one service builds both (`services/ai/document-content.ts`).
 * A document with no text yet is a 409 (`document_not_converted` / `document_conversion_failed`),
 * never an empty window — "no text" and "an empty document" are different answers.
 */
export const documentContentSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  source: z.string().nullable(),
  contentType: z.string(),
  status: documentStatusSchema,
  /** Characters in the WHOLE document, not this window. */
  totalChars: z.number().int().nonnegative(),
  /** How many passages the document was split into. */
  passages: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returnedChars: z.number().int().nonnegative(),
  text: z.string(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
})
export type DocumentContent = z.infer<typeof documentContentSchema>

/** Characters per window when the caller does not say (~5 000 tokens at 4 chars per token). */
export const DOCUMENT_WINDOW_CHARS = 20_000
/** The ceiling one `GET /:id/content` may return (~12 500 tokens; the same cap as an agent run). */
export const DOCUMENT_WINDOW_MAX_CHARS = 50_000

export const documentContentQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  maxChars: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOCUMENT_WINDOW_MAX_CHARS)
    .default(DOCUMENT_WINDOW_CHARS),
})
export type DocumentContentQuery = z.infer<typeof documentContentQuerySchema>

/**
 * Where a window starts: an arbitrary offset snapped DOWN to a multiple of the window size, so a
 * deep link (`?offset=41207`) and a reader paging with Previous/Next land on the same window and
 * share one cache entry instead of fetching a near-duplicate. Pure.
 */
export function windowStart(offset: number, size = DOCUMENT_WINDOW_CHARS): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0
  return Math.floor(offset / size) * size
}

/**
 * `GET /api/ai/documents/:id/passages` — the stored chunks, ordered by `seq`. The embedding is
 * never on the wire: the route names its columns so a later `select()` widening cannot leak it.
 */
export const documentPassageSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  /** Where the passage sits in the document's text; null when it cannot be located (re-chunked). */
  charOffset: z.number().int().nonnegative().nullable(),
  text: z.string(),
})
export type DocumentPassage = z.infer<typeof documentPassageSchema>

// ---- The document card -------------------------------------------------------------------------

/** How much of a document's text the card shows. */
export const DOCUMENT_EXCERPT_CHARS = 320

/**
 * The compact representation of a document — the Knowledge list, a Search result header, a chat
 * or agent citation. **`excerpt` is the first `DOCUMENT_EXCERPT_CHARS` characters of the text,
 * whitespace-collapsed — not a summary and not a thumbnail**: there is no `documents.summary`
 * column and no server-side rasterisation on Workers, so a converted PDF's excerpt is usually its
 * cover page, and it is `null` while a document is `pending` or `failed`.
 */
export const documentCardSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  /** `documentTypeLabel(contentType)` — "PDF", "Markdown", … */
  typeLabel: z.string(),
  contentType: z.string(),
  status: documentStatusSchema,
  excerpt: z.string().nullable(),
  passages: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  /** The uploaded original, downloadable at `filePath(fileId)`; null for pasted text. */
  fileId: z.string().uuid().nullable(),
  /** `documentPath(id)` — so a consumer never has to know the viewer's route. */
  href: z.string(),
})
export type DocumentCard = z.infer<typeof documentCardSchema>

/** The ONE place the viewer's route is written. Deep links carry the passage they came from. */
export function documentPath(
  id: string,
  options: { offset?: number | null; chunk?: string | null; q?: string | null; tab?: string } = {}
): string {
  const params = new URLSearchParams()
  if (options.tab) params.set('tab', options.tab)
  if (typeof options.offset === 'number' && options.offset >= 0) {
    params.set('offset', String(options.offset))
  }
  if (options.chunk) params.set('chunk', options.chunk)
  if (options.q) params.set('q', options.q)
  const query = params.toString()
  return `/documents/${id}${query ? `?${query}` : ''}`
}

/** Build a card from a `documents` row the caller already has (no request). */
export function documentCardFromDocument(
  doc: Document,
  excerpt: string | null = null
): DocumentCard {
  return {
    id: doc.id,
    title: doc.title,
    typeLabel: documentTypeLabel(doc.contentType),
    contentType: doc.contentType,
    status: doc.status,
    excerpt,
    passages: doc.chunkCount,
    sizeBytes: doc.sizeBytes,
    fileId: doc.fileId,
    href: documentPath(doc.id),
  }
}
