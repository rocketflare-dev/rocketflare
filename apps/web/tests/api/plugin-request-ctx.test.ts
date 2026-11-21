/**
 * `requestCtx(c).apiKeyId`: which API key authenticated a plugin's request — its id, never the
 * secret — and `null` for a browser session. Driven through the real config, database and auth
 * middleware on a one-route app, so the value is what a plugin route would read.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authMiddleware } from '@/api/middleware/auth'
import { configMiddleware } from '@/api/middleware/config'
import { databaseMiddleware } from '@/api/middleware/database'
import { errorHandler } from '@/api/middleware/error-handler'
import { requestIdMiddleware, requestLogger } from '@/api/middleware/request-logger'
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
app.use('*', requestIdMiddleware, requestLogger, configMiddleware, databaseMiddleware)
app.use('/probe', authMiddleware)
app.get('/probe', c => {
  const ctx = requestCtx(c)
  return c.json({ apiKeyId: ctx.apiKeyId, userId: ctx.userId })
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
