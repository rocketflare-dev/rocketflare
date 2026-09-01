import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError, notifyUnauthorized } from './api-client'

/** Global 401 → the registered handler (D20). Coalesced inside `notifyUnauthorized`. */
function onUnauthorized(error: unknown) {
  if (error instanceof ApiError && error.status === 401) notifyUnauthorized(error)
}

/**
 * Module-level client so non-React code (websocket store, `showToast` callers) can
 * invalidate or read the cache. Provided once in App.tsx.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 10 * 60 * 1000,
      // One retry for flaky networks — but never for a definitive 4xx
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.isClientError()) return false
        return failureCount < 1
      },
      retryDelay: attempt => Math.min(1000 * 2 ** attempt, 30_000),
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
    mutations: {
      retry: 0,
    },
  },
})
