import { ERROR_CODES } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '@/api/middleware/csrf'
import { json, request } from '../helpers/request'

describe('GET /api/health', () => {
  it('returns ok with version and env', async () => {
    const res = await request('/api/health')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ status: 'ok', version: 'test', env: 'development' })
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })
})

describe('GET /api/ready', () => {
  it('runs SELECT 1 through the per-request client', async () => {
    const res = await request('/api/ready')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ status: 'ready' })
  })
})

describe('not found', () => {
  it('unknown /api path → 404 JSON envelope', async () => {
    const res = await request('/api/nope')
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: ERROR_CODES.notFound })
  })

  it.each(['/auth/x', '/cubejs-api/v1/load', '/mcp', '/ws'])('%s → JSON 404', async path => {
    const res = await request(path)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('non-API path falls through to the ASSETS binding', async () => {
    const res = await request('/some/spa/route')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('ASSETS stub')
  })

  it('/apifoo is not an API path', async () => {
    const res = await request('/apifoo')
    expect(await res.text()).toContain('ASSETS stub')
  })
})

describe('CSRF', () => {
  it('POST without a session cookie passes through (nothing to forge) → 404', async () => {
    const res = await request('/api/anything', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.notFound })
  })

  it('POST with session cookie + cross-site Origin → 403 csrf_failed', async () => {
    const res = await request('/api/anything', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=abc`, Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: ERROR_CODES.csrf })
  })

  it('POST with session cookie + Sec-Fetch-Site: cross-site → 403 csrf_failed', async () => {
    const res = await request('/api/anything', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=abc`, 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.csrf })
  })

  it('POST with session cookie + allowed Origin passes', async () => {
    const res = await request('/api/anything', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=abc`, Origin: 'http://localhost:3001' },
    })
    expect(res.status).toBe(404)
  })
})

describe('CORS', () => {
  it('answers a preflight from the dev UI origin', async () => {
    const res = await request('/api/health', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('does not echo an unknown origin', async () => {
    const res = await request('/api/health', { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('body limit', () => {
  it('rejects a >1MB body with a 413 envelope', async () => {
    const res = await request('/api/anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) },
      body: 'x'.repeat(2 * 1024 * 1024),
    })
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
  })
})
