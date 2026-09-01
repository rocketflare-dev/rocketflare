/**
 * KV rate limiting + operation lock (D14) against the in-memory KV: the 11th request in a minute
 * is 429 with Retry-After; no binding → no limit; the lock refuses a concurrent second caller.
 */
import { describe, expect, it } from 'vitest'
import { checkRateLimit, operationLock } from '@/api/middleware/rate-limit'
import { uniqueId } from '../helpers/auth'
import { json, request } from '../helpers/request'
import { createTestEnv, MemoryKV } from '../mocks/bindings'

describe('authRateLimit on /auth/magic-link/request', () => {
  it('allows 10 per minute per IP, then 429 rate_limited with Retry-After', async () => {
    const env = createTestEnv() // ONE env = one KV shared by every request below
    const headers = { 'cf-connecting-ip': '203.0.113.7' }
    const body = { json: { email: `rl_${uniqueId().toLowerCase()}@example.test` }, env }
    for (let i = 0; i < 10; i++) {
      const res = await request('/auth/magic-link/request', { method: 'POST', headers }, body)
      expect(res.status, `request ${i + 1}`).toBe(202)
    }
    const blocked = await request('/auth/magic-link/request', { method: 'POST', headers }, body)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await json(blocked)).toMatchObject({ statusCode: 429, code: 'rate_limited' })
    // a different IP is unaffected
    const other = await request(
      '/auth/magic-link/request',
      { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.8' } },
      body
    )
    expect(other.status).toBe(202)
  })

  it('is a no-op without the KV binding', async () => {
    const env = createTestEnv({ RATE_LIMIT_KV: undefined })
    const headers = { 'cf-connecting-ip': '203.0.113.9' }
    for (let i = 0; i < 12; i++) {
      const res = await request(
        '/auth/dev-login',
        { method: 'POST', headers },
        { json: { email: `nolimit_${uniqueId().toLowerCase()}@example.test` }, env }
      )
      expect(res.status).toBe(200)
    }
  })

  it('also guards dev-login and OAuth start', async () => {
    const env = createTestEnv()
    const headers = { 'cf-connecting-ip': '203.0.113.10' }
    for (let i = 0; i < 10; i++) await request('/auth/google', { headers }, { env })
    expect((await request('/auth/google', { headers }, { env })).status).toBe(429)
    expect(
      (
        await request(
          '/auth/dev-login',
          { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.11' } },
          { json: { email: 'x' }, env }
        )
      ).status
    ).toBe(400)
  })
})

describe('checkRateLimit', () => {
  it('slides the window', async () => {
    const kv = new MemoryKV()
    const key = 'rl:test:1'
    for (let i = 0; i < 3; i++)
      expect((await checkRateLimit(kv, key, { max: 3, windowSeconds: 60 })).allowed).toBe(true)
    const denied = await checkRateLimit(kv, key, { max: 3, windowSeconds: 60 })
    expect(denied).toMatchObject({ allowed: false, remaining: 0 })
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    // age the hits out of the window
    await kv.put(
      key,
      JSON.stringify([Date.now() - 61_000, Date.now() - 61_000, Date.now() - 61_000])
    )
    expect((await checkRateLimit(kv, key, { max: 3, windowSeconds: 60 })).allowed).toBe(true)
  })
})

describe('operationLock', () => {
  it('runs fn, refuses a concurrent caller with 409, releases afterwards, and works without KV', async () => {
    const kv = new MemoryKV()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const first = operationLock(kv, 'tenant:x', async () => {
      await gate
      return 'first'
    })
    await new Promise(r => setTimeout(r, 5))
    await expect(operationLock(kv, 'tenant:x', async () => 'second')).rejects.toMatchObject({
      statusCode: 409,
      code: 'operation_in_progress',
    })
    release()
    expect(await first).toBe('first')
    expect(await operationLock(kv, 'tenant:x', async () => 'third')).toBe('third')
    expect(await operationLock(undefined, 'tenant:x', async () => 'nokv')).toBe('nokv')
    // a throwing fn still releases the lock
    await expect(
      operationLock(kv, 'tenant:y', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await kv.get('op_lock:tenant:y')).toBeNull()
  })
})
