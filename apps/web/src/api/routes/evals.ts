/**
 * `/api/evals` (D33): `GET /export?messageId=|runId=` turns one real answer into a draft
 * `EvalCase` for `rocketflare evals promote`. Admin+ (`read Feedback`): the draft is another
 * member's question, the passages retrieved for it and the answer they got — tenant data, which the
 * response says out loud (`containsTenantData: true`) so no reader can forget it.
 */
import { evalExportQuerySchema, evalExportResponseSchema } from '@rocketflare/shared/ai/evals'
import { guardPermission } from '../middleware/permissions'
import { exportEvalCase } from '../services/evals'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const evalsRouter = createRouter()

evalsRouter.get('/export', validate('query', evalExportQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Feedback')
  const evalCase = await exportEvalCase(db, tenantId, c.req.valid('query'))
  return c.json(evalExportResponseSchema.parse({ case: evalCase, containsTenantData: true }))
})
