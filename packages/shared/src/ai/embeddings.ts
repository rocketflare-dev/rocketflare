/**
 * Embeddings / retrieval contracts (D17, D18): the `documents` row the API returns (never the raw
 * text or vectors), the text-ingest request, and the hybrid search request/response. Retrieval
 * ships WITH this ingest path so `searchChunks` is never dead code (00 §1.3).
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
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
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
