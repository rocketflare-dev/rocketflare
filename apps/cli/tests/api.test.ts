/** API client tests: mocked fetch → envelope → CliApiError exit codes; zod validation of bodies. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildUrl, CliApiError, createApiClient } from '../src/api'
import { EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN, exitCodeFor } from '../src/errors'
import { captureError, headersOf, jsonResponse, mockFetch, TEST_KEY } from './helpers'

const SERVER = 'http://server.test'

describe('buildUrl', () => {
  it('joins path and drops undefined query values', () => {
    expect(buildUrl(`${SERVER}/`, '/api/members', { page: 2, pageSize: undefined, q: 'a b' })).toBe(
      `${SERVER}/api/members?page=2&q=a+b`
    )
    expect(buildUrl(SERVER, 'api/health')).toBe(`${SERVER}/api/health`)
  })
})

describe('createApiClient', () => {
  it('sends Bearer auth + JSON accept header and validates the body', async () => {
    const { fetch, calls } = mockFetch({
      '/api/thing': () => jsonResponse({ id: 'x', n: 1 }),
    })
    const client = createApiClient({ serverUrl: SERVER, apiKey: TEST_KEY, fetch })
    const data = await client.get('/api/thing', {
      schema: z.object({ id: z.string(), n: z.number() }),
      query: { page: 1 },
    })
    expect(data).toEqual({ id: 'x', n: 1 })
    const headers = headersOf(calls)
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(headers.Accept).toBe('application/json')
    expect(headers['User-Agent']).toMatch(/^rocketflare-cli\//)
    expect(calls[0]?.url.search).toBe('?page=1')
  })

  it('omits Authorization without a key and posts JSON bodies', async () => {
    const { fetch, calls } = mockFetch({ '/api/x': () => new Response(null, { status: 204 }) })
    const client = createApiClient({ serverUrl: SERVER, fetch })
    expect(await client.post('/api/x', { body: { a: 1 } })).toBeUndefined()
    const init = calls[0]?.init
    expect(headersOf(calls).Authorization).toBeUndefined()
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"a":1}')
  })

  it('maps the 401 envelope to CliApiError → exit 2 with a login hint', async () => {
    const { fetch } = mockFetch({
      '/api/me': () =>
        jsonResponse({ error: 'Unauthorized', statusCode: 401, code: 'unauthorized' }, 401),
    })
    const client = createApiClient({ serverUrl: SERVER, apiKey: 'bad', fetch })
    const error = await captureError(client.get('/api/me'))
    expect(error).toBeInstanceOf(CliApiError)
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Unauthorized' })
    expect(error.hint).toContain('rocketflare login')
    expect(exitCodeFor(error)).toBe(EXIT_NOT_LOGGED_IN)
  })

  it('maps 403 → exit 3 and keeps the envelope body', async () => {
    const body = {
      error: 'Forbidden',
      statusCode: 403,
      code: 'forbidden',
      details: { need: 'admin' },
    }
    const { fetch } = mockFetch({ '/api/activity': () => jsonResponse(body, 403) })
    const client = createApiClient({ serverUrl: SERVER, apiKey: TEST_KEY, fetch })
    const error = await captureError(client.get('/api/activity'))
    expect(error).toMatchObject({ status: 403, code: 'forbidden', body })
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })

  it('handles non-envelope failures (HTML 502) → exit 1', async () => {
    const { fetch } = mockFetch({
      '/api/health': () => new Response('<html>bad gateway</html>', { status: 502 }),
    })
    const client = createApiClient({ serverUrl: SERVER, fetch })
    const error = await captureError(client.get('/api/health'))
    expect(error).toBeInstanceOf(CliApiError)
    expect(error.status).toBe(502)
    expect(error.message).toMatch(/HTTP 502/)
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
  })

  it('reports a schema mismatch as invalid_response but keeps the raw body', async () => {
    const { fetch } = mockFetch({ '/api/thing': () => jsonResponse({ id: 42 }) })
    const client = createApiClient({ serverUrl: SERVER, apiKey: TEST_KEY, fetch })
    const error = await captureError(
      client.request('GET', '/api/thing', { schema: z.object({ id: z.string() }) })
    )
    expect(error).toMatchObject({ status: 200, code: 'invalid_response', body: { id: 42 } })
    expect(error.message).toMatch(/GET \/api\/thing at id/)
  })

  it('wraps network failures as status 0 network_error → exit 1', async () => {
    const cause = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    const client = createApiClient({ serverUrl: SERVER, fetch: () => Promise.reject(cause) })
    const error = await captureError(client.get('/api/health'))
    expect(error).toMatchObject({ status: 0, code: 'network_error' })
    expect(error.message).toBe(`Could not reach ${SERVER} (ECONNREFUSED)`)
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
  })

  it('returns raw + parsed from request()', async () => {
    const { fetch } = mockFetch({
      '/api/t': () => jsonResponse({ at: '2026-01-02T03:04:05.000Z' }),
    })
    const client = createApiClient({ serverUrl: SERVER, fetch })
    const res = await client.request('GET', '/api/t', { schema: z.object({ at: z.coerce.date() }) })
    expect(res.raw).toEqual({ at: '2026-01-02T03:04:05.000Z' })
    expect(res.data.at).toBeInstanceOf(Date)
  })

  it.each(['PUT', 'PATCH'] as const)('sends %s with a JSON body', async method => {
    const { fetch, calls } = mockFetch({ '/api/thing': () => jsonResponse({ ok: true }) })
    const client = createApiClient({ serverUrl: SERVER, fetch })
    const res = await client.request(method, '/api/thing', { body: { name: 'a' } })
    expect(res.data).toEqual({ ok: true })
    expect(calls[0].init.method).toBe(method)
    expect(calls[0].init.body).toBe('{"name":"a"}')
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json')
  })
})

describe('raw transfers', () => {
  const client = (routes: Parameters<typeof mockFetch>[0]) => {
    const { fetch, calls } = mockFetch(routes)
    return {
      calls,
      api: createApiClient({ serverUrl: 'http://test.local', apiKey: 'k', fetch }),
    }
  }

  it('reads bytes with the API key and reports a failure as a CliApiError', async () => {
    const { api, calls } = client({ '/file': () => new Response(new Uint8Array([1, 2])) })
    expect([...(await api.getBytes('/file'))]).toEqual([1, 2])
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer k')
    await expect(api.getBytes('/missing')).rejects.toMatchObject({ status: 404 })
  })
})

describe('upload', () => {
  const UPLOAD_ID = '00000000-0000-4000-8000-000000000001'
  const ticket = {
    uploadId: UPLOAD_ID,
    method: 'PUT',
    url: 'https://acct.r2.cloudflarestorage.com/bucket/tenants/t/uploads/x',
    headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*' },
    expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const file = { name: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hi') }

  it('asks for a URL, PUTs the bytes there without the API key, then confirms', async () => {
    const { fetch, calls } = mockFetch({
      '/api/uploads': () => jsonResponse(ticket, 201),
      '/bucket/tenants/t/uploads/x': () => new Response(null, { status: 200 }),
      [`/api/uploads/${UPLOAD_ID}/confirm`]: () => jsonResponse({ id: 'f' }, 201),
    })
    const api = createApiClient({ serverUrl: 'http://test.local', apiKey: 'k', fetch })
    expect(await api.upload('uploads', file, { fields: { title: 'A' } })).toEqual({ id: 'f' })

    const [presign, put, confirm] = calls
    expect(JSON.parse(String(presign?.init.body))).toEqual({
      target: 'uploads',
      name: 'a.txt',
      contentType: 'text/plain',
      size: 2,
      fields: { title: 'A' },
    })
    expect(put?.init.method).toBe('PUT')
    expect(new Headers(put?.init.headers).get('authorization')).toBeNull()
    expect(new Headers(put?.init.headers).get('if-none-match')).toBe('*')
    expect(await new Response(put?.init.body).text()).toBe('hi')
    expect(confirm?.init.method).toBe('POST')
    expect(new Headers(confirm?.init.headers).get('authorization')).toBe('Bearer k')
  })

  it('a PUT the store refuses is upload_refused, and nothing is confirmed', async () => {
    const { fetch, calls } = mockFetch({
      '/api/uploads': () => jsonResponse(ticket, 201),
      '/bucket/tenants/t/uploads/x': () => new Response('<Error/>', { status: 403 }),
    })
    const api = createApiClient({ serverUrl: 'http://test.local', apiKey: 'k', fetch })
    await expect(api.upload('uploads', file)).rejects.toMatchObject({
      status: 403,
      code: 'upload_refused',
    })
    expect(calls).toHaveLength(2)
  })
})
