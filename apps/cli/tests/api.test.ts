/** API client tests (D26): mocked fetch → envelope → CliApiError exit codes; zod validation of bodies. */
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
})
