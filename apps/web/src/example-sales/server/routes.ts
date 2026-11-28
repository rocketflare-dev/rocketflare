/**
 * `/api/example-sales` — leads: list, create, assign. Assigning asks `example-hr` whether the new
 * owner is on leave, through its `public.ts` — the one door into another domain, and only because
 * `index.ts` lists `example-hr` in `dependsOn`. The call carries THIS request's context, so HR's
 * own rule (who may read leave) is applied to this caller.
 */
import {
  type AssignLead,
  assignLeadSchema,
  type CreateLead,
  createLeadSchema,
  EXAMPLE_LEAD_SUBJECT,
  EXAMPLE_SALES_LEADS_ENTITY,
  type LeadListQuery,
  leadListQuerySchema,
} from '@rocketflare/shared/example-sales/index'
import { whoIsOnLeave } from '@/example-hr/public'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx, validate } from '@/plugins/api'
import { createLead, getLead, listLeads, setLeadOwner } from './leads'

export const exampleSalesRouter = createRouter()

exampleSalesRouter.get('/leads', validate('query', leadListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_LEAD_SUBJECT)
  const query = ctx.valid<LeadListQuery>('query')
  const { items, total } = await listLeads(ctx.db, ctx.tenantId, query)
  return c.json(ctx.page(items, total, query))
})

exampleSalesRouter.post('/leads', validate('json', createLeadSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('create', EXAMPLE_LEAD_SUBJECT)
  const row = await createLead(ctx.db, ctx.tenantId, ctx.userId, ctx.valid<CreateLead>('json'))
  ctx.nudge(EXAMPLE_SALES_LEADS_ENTITY, row.id)
  return c.json(row, 201)
})

exampleSalesRouter.post('/leads/:id/assign', validate('json', assignLeadSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('update', EXAMPLE_LEAD_SUBJECT)
  const id = ctx.uuid('id')
  if (!(await getLead(ctx.db, ctx.tenantId, id))) ctx.notFound('Lead not found')
  const { ownerUserId } = ctx.valid<AssignLead>('json')
  if (ownerUserId !== null) {
    const away = await whoIsOnLeave(ctx, [ownerUserId])
    if (away.length > 0) {
      ctx.conflict('That person is on leave today', 'example_sales_owner_on_leave')
    }
  }
  const row = await setLeadOwner(ctx.db, ctx.tenantId, id, ownerUserId)
  if (!row) ctx.notFound('Lead not found')
  ctx.nudge(EXAMPLE_SALES_LEADS_ENTITY, row.id)
  return c.json(row)
})
