/**
 * `/api/agents` (D7): the registry and its runs. `POST /runs` is the handoff — validate → insert
 * `queued` → create the Workflow instance → 202 with the row (the route never runs the agent). An
 * exclusive agent with an active run answers THAT run with `deduplicated: true` (409
 * `agent_run_active` only with `?strict=1`). `GET /runs/:id` returns the row + its durable events
 * after `reconcileRun` (a stale active row whose instance is gone is settled on read — `not_found`
 * is an answer). Members see and cancel their OWN runs; admin+ (`isAdminLevel`) every run in the
 * tenant. Every query carries the tenant predicate from the auth context.
 */
import {
  type AgentRunWithEvents,
  agentRunListQuerySchema,
  createAgentRunRequestSchema,
} from '@rocketflare/shared/ai/agents'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { and, count, desc, eq } from 'drizzle-orm'
import { type AgentRunRow, agentRuns } from '../../db/schema'
import { guardPermission, isAdminLevel } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { listAgentInfo } from '../services/agents/registry'
import {
  enqueueRun,
  getRun,
  listEvents,
  reconcileRun,
  requestCancel,
  toAgentRun,
  toAgentRunEvent,
} from '../services/agents/runs'
import type { AuthContext } from '../types'
import { ConflictError, NotFoundError } from '../utils/core/errors'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const agentsRouter = createRouter()

/** A member may only see runs they requested; admin+ see the tenant's. Others' runs are 404. */
function visible(auth: AuthContext, run: AgentRunRow): boolean {
  return isAdminLevel(auth) || run.requestedByUserId === auth.user.id
}

// ---- GET /api/agents ------------------------------------------------------------------------------

agentsRouter.get('/', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  return c.json({ items: listAgentInfo() })
})

// ---- GET /api/agents/runs -------------------------------------------------------------------------

agentsRouter.get('/runs', validate('query', agentRunListQuerySchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const query = c.req.valid('query')
  const { limit, offset } = pageWindow(query)
  const where = and(
    eq(agentRuns.tenantId, tenantId),
    isAdminLevel(auth) ? undefined : eq(agentRuns.requestedByUserId, user.id),
    query.agentKey ? eq(agentRuns.agentKey, query.agentKey) : undefined,
    query.status ? eq(agentRuns.status, query.status) : undefined
  )
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(agentRuns).where(where),
  ])
  return c.json(paginated(rows.map(toAgentRun), total?.n ?? 0, query))
})

// ---- POST /api/agents/runs ------------------------------------------------------------------------

agentsRouter.post('/runs', validate('json', createAgentRunRequestSchema), async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'create', 'AgentRun')
  const { agentKey, input } = c.req.valid('json')
  const strict = c.req.query('strict') === '1'
  const { run, deduplicated } = await enqueueRun(db, c.env, {
    tenantId,
    agentKey,
    input,
    userId: user.id,
    realtime,
  })
  if (deduplicated && strict) {
    throw new ConflictError(
      `A ${agentKey} run is already queued or running for this organisation`,
      ERROR_CODES.agentRunActive,
      { runId: run.id }
    )
  }
  if (!deduplicated) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'agent_run.requested',
        subjectType: 'AgentRun',
        subjectId: run.id,
        metadata: { agentKey },
      })
    )
  }
  return c.json({ ...toAgentRun(run), deduplicated }, 202)
})

// ---- GET /api/agents/runs/:id ---------------------------------------------------------------------

agentsRouter.get('/runs/:id', async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AgentRun')
  const row = await getRun(db, tenantId, uuidParam(c, 'id'))
  if (!row || !visible(auth, row)) throw new NotFoundError('Agent run not found')
  const run = await reconcileRun(db, c.env, row)
  const events = await listEvents(db, tenantId, run.id)
  const body: AgentRunWithEvents = { ...toAgentRun(run), events: events.map(toAgentRunEvent) }
  return c.json(body)
})

// ---- POST /api/agents/runs/:id/cancel -------------------------------------------------------------

agentsRouter.post('/runs/:id/cancel', async c => {
  const { db, tenantId, user, auth, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'update', 'AgentRun')
  const id = uuidParam(c, 'id')
  const row = await getRun(db, tenantId, id)
  if (!row || !visible(auth, row)) throw new NotFoundError('Agent run not found')
  const run = (await requestCancel(db, tenantId, id, realtime, c.env)) ?? row
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: run.status === 'cancelled' ? 'agent_run.cancelled' : 'agent_run.cancel_requested',
      subjectType: 'AgentRun',
      subjectId: run.id,
      metadata: { agentKey: run.agentKey, status: run.status },
    })
  )
  return c.json(toAgentRun(run))
})
