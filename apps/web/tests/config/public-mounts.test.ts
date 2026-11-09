/**
 * The host's guards on a plugin's PUBLIC mounts (`config` project, no database). A test-local app
 * wired with the SAME two calls `api/index.ts` makes — `apiBodyLimit(publicBodyLimitOverrides(…))`
 * at step 5 and `mountPublicRoutes(…)` in the mount section — so what is exercised is the wiring,
 * not a copy of it:
 *
 *   - a mount that declares nothing is rate-limited per IP (`PUBLIC_MOUNT_RATE_LIMIT`), in a bucket
 *     of its own; `rateLimit: false` turns that off; no `RATE_LIMIT_KV` → no limit;
 *   - `bodyLimitBytes` replaces the 1 MB cap beneath its prefix, for JSON, form-encoded and
 *     `application/scim+json` bodies alike, while every other `/api` path keeps 1 MB.
 */
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { apiBodyLimit, MAX_JSON_BODY_BYTES } from '@/api/middleware/body-limit'
import { errorHandler } from '@/api/middleware/error-handler'
import {
  mountPublicRoutes,
  PUBLIC_MOUNT_RATE_LIMIT,
  publicBodyLimitOverrides,
} from '@/api/middleware/public-mounts'
import type { AppEnv } from '@/api/types'
import { createRouter } from '@/api/utils/routes/router'
import type { PluginPublicMount } from '@/plugins/types'
import { MemoryKV } from '../mocks/bindings'

const OVERRIDE_BYTES = 3 * 1024 * 1024

/** A router that reads the whole body, so a cap that let too much through would be visible. */
function echoRouter(): Hono<AppEnv> {
  const router = createRouter()
  router.all('/*', async c => {
    const body = c.req.method === 'GET' ? '' : await c.req.text()
    return c.json({ bytes: body.length })
  })
  return router
}

function hostApp(mounts: readonly PluginPublicMount[]): Hono<AppEnv> {
  const app = createRouter()
  app.onError(errorHandler)
  app.use('/api/*', apiBodyLimit(publicBodyLimitOverrides(mounts)))
  mountPublicRoutes(app, mounts)
  app.route('/api/other', echoRouter())
  return app
}

const env = (kv?: MemoryKV) => ({ RATE_LIMIT_KV: kv }) as unknown as AppEnv['Bindings']
const fromIp = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } })

describe('plugin upload paths', () => {
  const app = createRouter()
  app.onError(errorHandler)
  app.use('/api/*', apiBodyLimit([], ['/api/orders/upload']))
  app.route('/api/orders', echoRouter())
  const big = { method: 'POST', body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) }

  it('skips the JSON cap beneath a declared path only', async () => {
    expect((await app.request('/api/orders/upload', big)).status).not.toBe(413)
    expect((await app.request('/api/orders/uploads', big)).status).toBe(413)
    expect((await app.request('/api/orders', big)).status).toBe(413)
  })
})

describe('public mount rate limit', () => {
  const app = hostApp([
    ['/api/hooks/alpha', echoRouter()],
    ['/api/hooks/beta', echoRouter()],
    ['/api/hooks/batcher', echoRouter(), { rateLimit: false }],
    ['/api/hooks/tight', echoRouter(), { rateLimit: { max: 2, windowSeconds: 60 } }],
  ])

  it('applies the default per IP when a mount declares nothing, then 429 rate_limited', async () => {
    const e = env(new MemoryKV())
    const { max } = PUBLIC_MOUNT_RATE_LIMIT
    for (let i = 0; i < max; i++) {
      const res = await app.request('/api/hooks/alpha/callback', fromIp('203.0.113.1'), e)
      expect(res.status, `request ${i + 1}`).toBe(200)
    }
    const blocked = await app.request('/api/hooks/alpha', fromIp('203.0.113.1'), e)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await blocked.json()).toMatchObject({ statusCode: 429, code: 'rate_limited' })
    // Another IP, and another plugin's prefix for the same IP, each have their own bucket.
    expect((await app.request('/api/hooks/alpha', fromIp('203.0.113.2'), e)).status).toBe(200)
    expect((await app.request('/api/hooks/beta', fromIp('203.0.113.1'), e)).status).toBe(200)
  })

  it('honours a declared limit', async () => {
    const e = env(new MemoryKV())
    for (let i = 0; i < 2; i++) {
      expect((await app.request('/api/hooks/tight/x', fromIp('203.0.113.3'), e)).status).toBe(200)
    }
    expect((await app.request('/api/hooks/tight/x', fromIp('203.0.113.3'), e)).status).toBe(429)
  })

  it('is off for a mount that declares rateLimit: false', async () => {
    const kv = new MemoryKV()
    const e = env(kv)
    for (let i = 0; i < PUBLIC_MOUNT_RATE_LIMIT.max + 5; i++) {
      expect((await app.request('/api/hooks/batcher', fromIp('203.0.113.4'), e)).status).toBe(200)
    }
    expect(kv.store.size).toBe(0)
  })

  it('is a no-op without the KV binding', async () => {
    for (let i = 0; i < PUBLIC_MOUNT_RATE_LIMIT.max + 5; i++) {
      expect((await app.request('/api/hooks/alpha', fromIp('203.0.113.5'), env())).status).toBe(200)
    }
  })

  it('counts a nested mount once, in its own bucket', async () => {
    const nested = hostApp([
      ['/api/hooks/sso', echoRouter(), { rateLimit: { max: 1, windowSeconds: 60 } }],
      ['/api/hooks/sso/scim', echoRouter(), { rateLimit: { max: 3, windowSeconds: 60 } }],
    ])
    const e = env(new MemoryKV())
    for (let i = 0; i < 3; i++) {
      expect((await nested.request('/api/hooks/sso/scim/Users', fromIp('1.2.3.4'), e)).status).toBe(
        200
      )
    }
    expect((await nested.request('/api/hooks/sso/scim/Users', fromIp('1.2.3.4'), e)).status).toBe(
      429
    )
    expect((await nested.request('/api/hooks/sso/acs', fromIp('1.2.3.4'), e)).status).toBe(200)
  })
})

describe('public mount body limit', () => {
  const app = hostApp([
    ['/api/hooks/sso', echoRouter(), { rateLimit: false, bodyLimitBytes: OVERRIDE_BYTES }],
    ['/api/hooks/plain', echoRouter(), { rateLimit: false }],
  ])
  const over1MB = 'a'.repeat(MAX_JSON_BODY_BYTES + 1024)
  const overOverride = 'a'.repeat(OVERRIDE_BYTES + 1)

  const post = (path: string, contentType: string, body: string, chunked = false) => {
    // `chunked` streams the body with no Content-Length, the path where the cap counts bytes.
    const payload = chunked ? new Blob([body]).stream() : body
    return app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: payload,
        ...(chunked ? { duplex: 'half' } : {}),
      } as RequestInit,
      env()
    )
  }

  const bodies = {
    json: ['application/json', (s: string) => JSON.stringify({ blob: s })],
    form: ['application/x-www-form-urlencoded', (s: string) => `SAMLResponse=${s}&RelayState=r`],
    scim: ['application/scim+json', (s: string) => JSON.stringify({ Operations: [s] })],
  } as const

  for (const [kind, [type, make]] of Object.entries(bodies)) {
    it(`admits a ${kind} body over 1 MB but under the override, and refuses one over it`, async () => {
      const ok = await post('/api/hooks/sso/acs', type, make(over1MB))
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { bytes: number }).bytes).toBeGreaterThan(MAX_JSON_BODY_BYTES)
      const tooBig = await post('/api/hooks/sso/acs', type, make(overOverride))
      expect(tooBig.status).toBe(413)
      expect(await tooBig.json()).toMatchObject({ code: 'payload_too_large' })
      // Streamed with no Content-Length: the same two answers.
      expect((await post('/api/hooks/sso', type, make(over1MB), true)).status).toBe(200)
      expect((await post('/api/hooks/sso', type, make(overOverride), true)).status).toBe(413)
    })
  }

  it('leaves every other /api path, and a mount with no override, at 1 MB', async () => {
    for (const path of ['/api/hooks/plain', '/api/other', '/api/hooks/ssox']) {
      const res = await post(path, 'application/x-www-form-urlencoded', `x=${over1MB}`)
      expect(res.status, path).toBe(413)
    }
    expect((await post('/api/hooks/plain', 'application/json', '{"a":1}')).status).toBe(200)
  })
})
