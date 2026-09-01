import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial router location (default `/`) */
  route?: string
  /** Supply your own client to assert on the cache */
  queryClient?: QueryClient
}

/** A fresh client with retries off so failing queries settle immediately. */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
}

/**
 * Render inside `QueryClientProvider` + `MemoryRouter` — the two providers every shell
 * component needs. Phase 1 adds `AuthProvider`/`AbilityProvider` here (with a `session`
 * option) so tests never build the stack by hand.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', queryClient = createTestQueryClient(), ...options }: ProviderOptions = {}
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[route]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) }
}

/** JSON `Response` helper for `vi.stubGlobal('fetch', …)`. */
export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Stub `fetch` so `/api/health` answers with the given app info; everything else 404s. */
export function stubHealthFetch(info: Record<string, unknown> = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/health')) {
      return Promise.resolve(
        jsonResponse({ status: 'ok', version: '1.2.3', env: 'staging', ...info })
      )
    }
    return Promise.resolve(
      jsonResponse({ error: 'Not found', statusCode: 404, code: 'not_found' }, 404)
    )
  })
}
