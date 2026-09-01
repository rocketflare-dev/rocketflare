/**
 * drizzle-cube client wiring (D19, D20). Wraps `CubeProvider` so every chart, portlet and the
 * analysis builder talk to OUR `/cubejs-api/v1` with the same-origin cookie session: the client
 * is told `credentials: 'include'` and sends the kit's `X-Requested-With: fetch` marker, exactly
 * like `lib/api-client`. drizzle-cube runs its queries on a `QueryClient` of its own (its bundled
 * TanStack Query, separate context from the app's), so the one we hand it carries a
 * `QueryCache.onError` that routes a 401 (`CubeQueryError.status`) into the kit's global
 * unauthorized handler — a stale session on a dashboard lands on `/login?returnUrl=` like
 * everywhere else. Mount this INSIDE the lazy analytics pages only: importing it pulls the
 * drizzle-cube runtime and its stylesheet, which must never enter the main bundle.
 */
import 'drizzle-cube/client/styles.css'
import { QueryCache, QueryClient } from '@tanstack/react-query'
import type { CubeApiOptions, FeaturesConfig } from 'drizzle-cube/client'
import { CubeProvider } from 'drizzle-cube/client/providers'
import { type ReactNode, useEffect, useState } from 'react'
import { ApiError, notifyUnauthorized } from '@/ui/lib/api-client'

export const CUBE_API_URL = '/cubejs-api/v1'

/** What every drizzle-cube request carries. Exported so tests can assert the exact options. */
export const cubeApiOptions: CubeApiOptions = {
  apiUrl: CUBE_API_URL,
  credentials: 'include',
  headers: { 'X-Requested-With': 'fetch' },
}

/** Kit defaults: no AI panel (the kit has its own AI surface), the analysis builder as editor. */
export const cubeFeatures: FeaturesConfig = {
  enableAI: false,
  useAnalysisBuilder: true,
  editToolbar: 'top',
}

/** A failed cube request whose HTTP status was 401 (`CubeQueryError` carries `status`). */
export function isCubeUnauthorized(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401
  )
}

function onCubeError(error: unknown) {
  if (isCubeUnauthorized(error)) {
    notifyUnauthorized(
      new ApiError({ error: 'Unauthorized', statusCode: 401, code: 'unauthorized' })
    )
  }
}

/** The client drizzle-cube runs its queries on. Never retries a definitive 4xx. */
export function createCubeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onCubeError }),
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status
          if (typeof status === 'number' && status < 500) return false
          return failureCount < 1
        },
      },
    },
  })
}

/**
 * drizzle-cube decides light/dark for its chart palettes from `data-theme="dark"` or a `dark`
 * class on `<html>` — it does not know `rocketflare-dark`. While a cube surface is mounted, mirror the
 * kit's theme attribute (the state, set by ThemeToggle) into that class; the kit's own CSS never
 * reads it. The `--dc-*` variables themselves are mapped in index.css per `data-theme`.
 */
export function syncDarkClass(root: HTMLElement = document.documentElement): () => void {
  const apply = () =>
    root.classList.toggle('dark', root.getAttribute('data-theme') === 'rocketflare-dark')
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    observer.disconnect()
    root.classList.remove('dark')
  }
}

interface CubeClientProviderProps {
  children: ReactNode
  features?: Partial<FeaturesConfig>
}

export function CubeClientProvider({ children, features }: CubeClientProviderProps) {
  const [queryClient] = useState(createCubeQueryClient)
  useEffect(() => syncDarkClass(), [])
  return (
    <CubeProvider
      apiOptions={cubeApiOptions}
      queryClient={queryClient}
      features={{ ...cubeFeatures, ...features }}
    >
      {children}
    </CubeProvider>
  )
}
