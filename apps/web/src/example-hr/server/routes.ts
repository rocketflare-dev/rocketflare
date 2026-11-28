/**
 * `/api/example-hr` — leave requests: list, create, decide. Mounted behind the domain's flag
 * (`index.ts`). Approving emits `example-hr.leave.approved`, which `example-sales` handles.
 */
import {
  type CreateLeaveRequest,
  createLeaveRequestSchema,
  type DecideLeaveRequest,
  decideLeaveRequestSchema,
  EXAMPLE_HR_LEAVE_ENTITY,
  EXAMPLE_LEAVE_APPROVED_EVENT,
  EXAMPLE_LEAVE_SUBJECT,
  type LeaveRequestListQuery,
  leaveRequestListQuerySchema,
} from '@rocketflare/shared/example-hr/index'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx, validate } from '@/plugins/api'
import { createLeaveRequest, decideLeaveRequest, getLeaveRequest, listLeaveRequests } from './leave'

export const exampleHrRouter = createRouter()

exampleHrRouter.get('/leave-requests', validate('query', leaveRequestListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_LEAVE_SUBJECT)
  const query = ctx.valid<LeaveRequestListQuery>('query')
  const { items, total } = await listLeaveRequests(ctx.db, ctx.tenantId, query)
  return c.json(ctx.page(items, total, query))
})

exampleHrRouter.post('/leave-requests', validate('json', createLeaveRequestSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('create', EXAMPLE_LEAVE_SUBJECT)
  const row = await createLeaveRequest(
    ctx.db,
    ctx.tenantId,
    ctx.userId,
    ctx.valid<CreateLeaveRequest>('json')
  )
  ctx.nudge(EXAMPLE_HR_LEAVE_ENTITY, row.id)
  return c.json(row, 201)
})

exampleHrRouter.post(
  '/leave-requests/:id/decision',
  validate('json', decideLeaveRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', EXAMPLE_LEAVE_SUBJECT)
    const id = ctx.uuid('id')
    const existing = await getLeaveRequest(ctx.db, ctx.tenantId, id)
    if (!existing) ctx.notFound('Leave request not found')
    const { decision } = ctx.valid<DecideLeaveRequest>('json')
    const row = await decideLeaveRequest(
      ctx.db,
      ctx.tenantId,
      id,
      ctx.userId,
      decision === 'approve' ? 'approved' : 'rejected'
    )
    if (!row) ctx.conflict('This leave request has already been decided')
    ctx.nudge(EXAMPLE_HR_LEAVE_ENTITY, row.id)
    if (row.status === 'approved') {
      // Recorded and fanned out to subscribers as queued jobs, never run here. The key names the
      // REQUEST, so a retried approval emits once.
      await ctx.emit(EXAMPLE_LEAVE_APPROVED_EVENT, {
        payload: {
          leaveRequestId: row.id,
          userId: row.userId,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
        },
        idempotencyKey: `leave:${row.id}`,
      })
    }
    return c.json(row)
  }
)
