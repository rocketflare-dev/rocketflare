/**
 * `CubeClientProvider` (D19, D20): the REAL drizzle-cube `CubeProvider` is mounted so what is
 * asserted is the library's own fetch — same-origin cookie credentials and the kit's
 * `X-Requested-With` marker on `/cubejs-api/v1/meta` — and that a 401 from the cube API reaches
 * the kit's global unauthorized handler through the QueryClient we hand the library. The
 * `createCubeQueryClient` unit test covers the same routing without the library in the loop.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CubeClientProvider,
  createCubeQueryClient,
  cubeApiOptions,
  isCubeUnauthorized,
  syncDarkClass,
} from '@/ui/components/analytics/CubeClientProvider'
import { setUnauthorizedHandler } from '@/ui/lib/api-client'
import { stubFetch, unauthorizedResponse } from './helpers/renderWithProviders'

const flushMicrotasks = () => new Promise<void>(r => queueMicrotask(r))

describe('CubeClientProvider', () => {
  beforeEach(() => {
    // drizzle-cube consults the OS preference when the theme attribute is not one it knows
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    document.documentElement.setAttribute('data-theme', 'rocketflare-light')
  })
  afterEach(() => {
    setUnauthorizedHandler(null)
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('declares cookie credentials and the kit request marker', () => {
    expect(cubeApiOptions).toEqual({
      apiUrl: '/cubejs-api/v1',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch' },
    })
  })

  it("the library's meta request carries credentials: include and X-Requested-With", async () => {
    const fetchMock = stubFetch({ '/cubejs-api/v1/meta': { cubes: [] } })
    render(
      <CubeClientProvider>
        <div>child</div>
      </CubeClientProvider>
    )
    expect(screen.getByText('child')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/cubejs-api/v1/meta'))
      ).toBe(true)
    )
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/cubejs-api/v1/meta')
    )
    const init = call?.[1]
    expect(init?.credentials).toBe('include')
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Requested-With')).toBe('fetch')
  })

  it('a 401 from the cube API fires the global unauthorized handler', async () => {
    stubFetch({ '/cubejs-api/v1/meta': () => unauthorizedResponse() })
    render(
      <CubeClientProvider>
        <div>child</div>
      </CubeClientProvider>
    )
    // Registered after mount on purpose: the last registration wins (AuthProvider does the same)
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(handler.mock.calls[0][0]).toMatchObject({ status: 401 })
  })

  it('createCubeQueryClient routes only 401s to the handler and never retries a 4xx', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    const client = createCubeQueryClient()
    const fail = (status: number) =>
      client
        .fetchQuery({
          queryKey: ['t', status],
          queryFn: () => Promise.reject(Object.assign(new Error('boom'), { status })),
        })
        .catch(() => undefined)
    await fail(403)
    await flushMicrotasks()
    expect(handler).not.toHaveBeenCalled()
    await fail(401)
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(client.getQueryState(['t', 401])?.fetchFailureCount).toBe(1) // one attempt, no retry
    expect(isCubeUnauthorized({ status: 401 })).toBe(true)
    expect(isCubeUnauthorized(new Error('x'))).toBe(false)
  })

  it('mirrors rocketflare-dark into the `dark` class drizzle-cube reads, and cleans up', async () => {
    const root = document.documentElement
    const stop = syncDarkClass(root)
    expect(root.classList.contains('dark')).toBe(false)
    root.setAttribute('data-theme', 'rocketflare-dark')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(true))
    root.setAttribute('data-theme', 'rocketflare-light')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(false))
    root.setAttribute('data-theme', 'rocketflare-dark')
    await waitFor(() => expect(root.classList.contains('dark')).toBe(true))
    stop()
    expect(root.classList.contains('dark')).toBe(false)
  })
})
