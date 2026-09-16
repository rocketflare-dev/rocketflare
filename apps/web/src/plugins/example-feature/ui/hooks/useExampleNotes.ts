/**
 * The plugin's data layer (D31) — the kit's hook conventions, inside a plugin's directory: one
 * hook file per resource, `api.*` for every request with the shared schema it was validated
 * against, and mutations that invalidate a family rather than writing into the cache.
 *
 * Realtime costs nothing here. The server nudges `entity.changed { entity:
 * 'example-feature:notes' }`, `invalidationsFor()` turns that into `[['example-feature:notes']]`,
 * and `WebSocketProvider` invalidates it — so these hooks never see a socket, which is the kit's
 * rule and not a plugin exception.
 */
import {
  type CreateExampleNoteRequest,
  type ExamplePingResponse,
  exampleNoteListResponseSchema,
  exampleNoteSchema,
  examplePingResponseSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { exampleNotesKeys } from '../query-keys'

export function useExampleNotes(page = 1) {
  return useQuery({
    queryKey: exampleNotesKeys.list(page),
    queryFn: () =>
      api.get(`/api/example-feature/notes?page=${page}`, {
        schema: exampleNoteListResponseSchema,
      }),
  })
}

/** One invalidation covers the list and any future detail — they share the family root. */
function useNotesInvalidation() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: exampleNotesKeys.all })
}

export function useCreateExampleNote() {
  const invalidate = useNotesInvalidation()
  return useMutation({
    mutationFn: (body: CreateExampleNoteRequest) =>
      api.post('/api/example-feature/notes', body, { schema: exampleNoteSchema }),
    onSuccess: invalidate,
  })
}

export function useDeleteExampleNote() {
  const invalidate = useNotesInvalidation()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/example-feature/notes/${id}`),
    onSuccess: invalidate,
  })
}

/** The smoke job: `POST /ping` enqueues `example-feature.ping` and answers 202 with its envelope. */
export function usePingExampleQueue() {
  return useMutation({
    mutationFn: (): Promise<ExamplePingResponse> =>
      api.post('/api/example-feature/ping', undefined, { schema: examplePingResponseSchema }),
  })
}
