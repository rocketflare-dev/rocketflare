/**
 * `GET /api/home/summary`: the signed-in Home's work areas in one request. Every member may call
 * it; each part is decided by the reader's permissions in `services/home.ts`, and a part they may
 * not see is `null`.
 */
import { homeSummarySchema } from '@rocketflare/shared/home'
import { homeSummary } from '../services/home'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const homeRouter = createRouter()

homeRouter.get('/summary', async c => {
  const { db, cfg, tenantId, auth } = withAuthAndDb(c)
  const summary = await homeSummary({ db, cfg, env: c.env, auth: { ...auth, tenantId } })
  return c.json(homeSummarySchema.parse(summary))
})
