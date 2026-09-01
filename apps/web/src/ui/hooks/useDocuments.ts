/**
 * Knowledge base (D18, D20): documents paginated (`GET /api/ai/documents`), one row (`GET /:id`),
 * text ingest (`POST /ingest` → 201, `indexed` inline for small texts or `pending` until the
 * `document.index` job lands), file upload (`POST /upload`, multipart — text types index like
 * pasted text, PDF/Office/HTML return `pending` until the `document.convert` job lands), delete
 * (`DELETE /:id` — own rows for everyone, any row for `delete Document`; the uploaded original goes
 * too), and hybrid search (`POST /search`). Search is mutation-style: a query is an action
 * the reader takes, its hits are shown once and never cached as server state. The raw text and
 * the vectors never reach the browser; only the sanitised `documents` row does.
 */
import {
  type Document,
  type DocumentStatus,
  documentSchema,
  type IngestTextRequest,
  type SearchRequest,
  type SearchResponse,
  searchResponseSchema,
  type UploadDocumentFields,
  validateDocumentFile,
} from '@rocketflare/shared/ai/embeddings'
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const documentsResponseSchema = paginatedResponse(documentSchema)

/** A `pending` document is still being indexed by the queue — re-read the list while any is. */
export const DOCUMENT_POLL_MS = 5000

export interface DocumentsFilters {
  page?: number
  pageSize?: number
  status?: DocumentStatus | ''
}

export function documentsQueryOptions(filters: DocumentsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.documents.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/ai/documents${toSearchParams(filters)}`, { schema: documentsResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function documentQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.documents.detail(id),
    queryFn: () =>
      api.get(`/api/ai/documents/${encodeURIComponent(id)}`, { schema: documentSchema }),
  })
}

export function useDocuments(filters: DocumentsFilters = {}) {
  return useQuery({
    ...documentsQueryOptions(filters),
    refetchInterval: q =>
      q.state.data?.items.some(d => d.status === 'pending') ? DOCUMENT_POLL_MS : false,
  })
}

export function useDocument(id: string | undefined) {
  return useQuery({ ...documentQueryOptions(id ?? ''), enabled: Boolean(id) })
}

export function useIngestText() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: IngestTextRequest) =>
      api.post<Document>('/api/ai/documents/ingest', body, { schema: documentSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documents.all }),
  })
}

/** Client-side mirror of the upload route's 415/413/400 — a message, or null when acceptable. */
export function validateDocumentUpload(file: File): string | null {
  return validateDocumentFile(file, MAX_UPLOAD_BYTES)
}

export interface UploadDocumentInput extends UploadDocumentFields {
  file: File
}

/** `POST /api/ai/documents/upload` — multipart `file` + optional `title` / `source`. */
export function useUploadDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, title, source }: UploadDocumentInput) => {
      const form = new FormData()
      form.append('file', file, file.name)
      if (title) form.append('title', title)
      if (source) form.append('source', source)
      return api.upload<Document>('/api/ai/documents/upload', form, { schema: documentSchema })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documents.all }),
  })
}

export function useDeleteDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/ai/documents/${encodeURIComponent(id)}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Document deleted',
      }),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.documents.detail(id) })
      return queryClient.invalidateQueries({ queryKey: queryKeys.documents.all })
    },
  })
}

/** `POST /api/ai/documents/search` — the hits are the mutation's `data`, ranked by fused score. */
export function useSearch() {
  return useMutation({
    mutationFn: (body: SearchRequest) =>
      api.post<SearchResponse>('/api/ai/documents/search', body, { schema: searchResponseSchema }),
  })
}
