/**
 * `/api/ai/usage` (D18): `GET /summary?from&to` — token totals per (provider, model, feature) for
 * the tenant, default last 30 days. Admin+ (`manage AiConfig`: usage is a cost/configuration
 * concern, not a member one).
 */
import { aiUsageSummaryQuerySchema, aiUsageSummarySchema } from '@rocketflare/shared/ai/usage'
import { guardPermission } from '../middleware/permissions'
import { summarizeUsage } from '../services/ai/usage'
import { BadRequestError } from '../utils/core/errors'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiUsageRouter = createRouter()

aiUsageRouter.get('/summary', validate('query', aiUsageSummaryQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const { from, to } = c.req.valid('query')
  if (from && to && from >= to)
    throw new BadRequestError('`from` must be before `to`', 'invalid_range')
  return c.json(aiUsageSummarySchema.parse(await summarizeUsage(db, tenantId, { from, to })))
})
