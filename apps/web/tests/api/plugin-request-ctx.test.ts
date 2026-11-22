/**
 * `requestCtx(c).apiKeyId`: which API key authenticated a plugin's request — its id, never the
 * secret — and `null` for a browser session. `requestCtx(c).embeddable(type)`: a plugin route
 * opts one response into same-origin framing, and only for a type the kit lets be framed. Driven
 * through the real config, database, security-header and auth middleware on a one-route app, so
 * the values are what a plugin route would read and send.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authMiddleware } from '@/api/middleware/auth'
import { configMiddleware } from '@/api/middleware/config'
import { databaseMiddleware } from '@/api/middleware/database'
import { errorHandler } from '@/api/middleware/error-handler'
import { requestIdMiddleware, requestLogger } from '@/api/middleware/request-logger'
import {
  CONTENT_SECURITY_POLICY,
  EMBEDDABLE_CONTENT_SECURITY_POLICY,
  securityHeaders,
} from '@/api/middleware/security-headers'
import type { AppEnv } from '@/api/types'
import { requestCtx } from '@/plugins/api'
import {
  bearerHeader,
  createTestApiKey,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

const app = new Hono<AppEnv>()
app.onError(errorHandler)
app.use(
  '*',
  requestIdMiddleware,
  requestLogger,
  configMiddleware,
  securityHeaders,
  databaseMiddleware
)
app.use('/probe', authMiddleware)
app.get('/probe', c => {
  const ctx = requestCtx(c)
  return c.json({ apiKeyId: ctx.apiKeyId, userId: ctx.userId })
})
app.use('/frame', authMiddleware)
app.get('/frame', c => {
  const ctx = requestCtx(c)
  const type = c.req.query('type') ?? ''
  const framed = ctx.embeddable(type)
  return c.body('bytes', 200, {
    'Content-Type': type || 'application/octet-stream',
    'X-Framed': String(framed),
  })
})

describe('requestCtx apiKeyId', () => {
  it('names the key a Bearer request came in on, and two keys of one person apart', async () => {
    const { user, tenant } = await createTestTenantWithUser(db)
    const first = await createTestApiKey(db, tenant.id, user.id)
    const second = await createTestApiKey(db, tenant.id, user.id)

    for (const { key, row } of [first, second]) {
      const res = await request('/probe', { headers: bearerHeader(key) }, { app })
      expect(res.status).toBe(200)
      const body = await json<{ apiKeyId: string | null; userId: string }>(res)
      expect(body).toEqual({ apiKeyId: row.id, userId: user.id })
      expect(JSON.stringify(body)).not.toContain(key)
    }
  })

  it('is null for a cookie session', async () => {
    const { user, tenant } = await createTestTenantWithUser(db)
    const token = await createTestSession(db, user.id, tenant.id)
    const res = await request('/probe', { headers: sessionCookieHeader(token) }, { app })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ apiKeyId: null, userId: user.id })
  })
})

describe('requestCtx embeddable', () => {
  async function frame(type: string) {
    const { user, tenant } = await createTestTenantWithUser(db)
    const token = await createTestSession(db, user.id, tenant.id)
    const res = await request(
      `/frame?type=${encodeURIComponent(type)}`,
      { headers: sessionCookieHeader(token) },
      { app }
    )
    expect(res.status).toBe(200)
    return res
  }

  it('lets a PDF response be framed by the same origin, and says so', async () => {
    const res = await frame('application/pdf; charset=binary')
    expect(res.headers.get('X-Framed')).toBe('true')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('Content-Security-Policy')).toBe(EMBEDDABLE_CONTENT_SECURITY_POLICY)
  })

  it('refuses a type the kit does not let be framed, leaving DENY in place', async () => {
    for (const type of ['text/html', 'image/svg+xml', '']) {
      const res = await frame(type)
      expect(res.headers.get('X-Framed')).toBe('false')
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY)
    }
  })
})
