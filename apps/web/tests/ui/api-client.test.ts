import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, api, setUnauthorizedHandler } from '@/ui/lib/api-client'
import { queryClient } from '@/ui/lib/queryClient'
import { jsonResponse } from './helpers/renderWithProviders'

function stubFetch(response: Response | (() => Response)) {
  const fn = vi.fn(() => Promise.resolve(typeof response === 'function' ? response() : response))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('api-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('sends credentials, JSON content-type and the X-Requested-With marker', async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }))
    await api.post('/api/things', { a: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/things')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
    })
  })

  it('parses the shared error envelope into ApiError', async () => {
    stubFetch(
      jsonResponse(
        {
          error: 'Validation failed',
          statusCode: 400,
          code: 'validation_failed',
          details: [{ path: ['email'], message: 'Invalid email' }],
        },
        400
      )
    )

    const error = await api.post('/api/things', {}, { showErrorToast: false }).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(400)
    expect(apiError.code).toBe('validation_failed')
    expect(apiError.message).toBe('Validation failed')
    expect(apiError.details).toEqual([{ path: ['email'], message: 'Invalid email' }])
    expect(apiError.body).toMatchObject({ error: 'Validation failed', statusCode: 400 })
    expect(apiError.isClientError()).toBe(true)
  })

  it('normalises a non-envelope error body', async () => {
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
    const error = (await api.get('/api/things').catch(e => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.message).toBe('Bad Gateway')
    expect(error.isServerError()).toBe(true)
  })

  it('calls the unauthorized handler once on 401', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    stubFetch(() =>
      jsonResponse({ error: 'Unauthorized', statusCode: 401, code: 'unauthorized' }, 401)
    )

    // A stale session fails every in-flight request at once — the handler still runs once
    const results = await Promise.all([
      api.get('/api/a').catch(e => e),
      api.get('/api/b').catch(e => e),
    ])
    for (const r of results) expect(r).toBeInstanceOf(ApiError)

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(handler.mock.calls[0][0]).toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('is a no-op on 401 when no handler is registered and stays usable after', async () => {
    stubFetch(() => jsonResponse({ error: 'Unauthorized', statusCode: 401 }, 401))
    await expect(api.get('/api/a')).rejects.toBeInstanceOf(ApiError)
    await new Promise(r => setTimeout(r, 0))
    // Registering later must still work — the coalescing flag was never left set
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    await api.get('/api/b').catch(() => {})
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
  })

  it('does not call the handler on 403', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    stubFetch(jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403))
    await api.get('/api/a').catch(() => {})
    await new Promise(r => setTimeout(r, 0))
    expect(handler).not.toHaveBeenCalled()
  })

  it('routes a 401 from a query through QueryCache.onError to the same handler', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    const error = new ApiError({ error: 'Unauthorized', statusCode: 401 })
    // Not via api-client: proves the QueryCache hook alone reaches the handler
    await queryClient
      .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(error), retry: false })
      .catch(() => {})
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    queryClient.clear()
  })

  it('validates the response against a zod schema', async () => {
    stubFetch(jsonResponse({ id: 1, name: 'x' }))
    const schema = z.object({ id: z.number(), name: z.string() })
    await expect(api.get('/api/thing', { schema })).resolves.toEqual({ id: 1, name: 'x' })

    stubFetch(jsonResponse({ id: 'nope' }))
    await expect(api.get('/api/thing', { schema })).rejects.toThrow(
      /Response validation failed for \/api\/thing/
    )
  })

  it('returns undefined for 204 / empty bodies', async () => {
    stubFetch(new Response(null, { status: 204 }))
    await expect(api.delete('/api/thing/1')).resolves.toBeUndefined()
    stubFetch(new Response('', { status: 200 }))
    await expect(api.get('/api/thing/1')).resolves.toBeUndefined()
  })

  // Deprecated (0.46.0): a plugin's own multipart route under `uploadPaths` keeps a client.
  describe('postForm (deprecated)', () => {
    function form() {
      const body = new FormData()
      body.append('file', new File(['hi'], 'a.txt', { type: 'text/plain' }))
      body.append('title', 'A')
      return body
    }

    it('posts the FormData itself, with the cookie and the CSRF marker but no JSON type', async () => {
      const fetchMock = stubFetch(jsonResponse({ id: 'f' }, 201))
      const body = form()
      const schema = z.object({ id: z.string() })
      await expect(api.postForm('/api/plugin-x/upload', body, { schema })).resolves.toEqual({
        id: 'f',
      })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/plugin-x/upload')
      expect(init.method).toBe('POST')
      expect(init.credentials).toBe('include')
      expect(init.body).toBe(body)
      // The browser writes the multipart Content-Type with its boundary; a JSON one breaks it.
      expect(new Headers(init.headers).get('content-type')).toBeNull()
      expect(new Headers(init.headers).get('x-requested-with')).toBe('fetch')
    })

    it('answers the shared error envelope as ApiError', async () => {
      stubFetch(
        jsonResponse({ error: 'Too large', statusCode: 413, code: 'payload_too_large' }, 413)
      )
      const error = (await api
        .postForm('/api/plugin-x/upload', form(), { showErrorToast: false })
        .catch(e => e)) as ApiError
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 413, code: 'payload_too_large' })
    })

    it('api.upload(url, formData), the 0.45 call, still posts the form', async () => {
      const fetchMock = stubFetch(jsonResponse({ id: 'f' }, 201))
      const body = form()
      await expect(api.upload('/api/plugin-x/upload', body)).resolves.toEqual({ id: 'f' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/plugin-x/upload')
      expect(init.body).toBe(body)
      expect(new Headers(init.headers).get('content-type')).toBeNull()
    })
  })
})
