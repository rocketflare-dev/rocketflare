/**
 * `/api/admin/*` (D9, D10, D25) behind `globalAdminMiddleware` — the only cross-tenant surface.
 * Thin: every operation lives in services/admin.ts. `GET /tenants` (the list) is 404
 * `tenancy_mode_single` in single mode; detail, suspend and support enter/leave still work.
 */
import {
  accessRequestListQuerySchema,
  decideAccessRequestSchema,
} from '@gmgo/shared/access-requests'
import {
  adminTenantListQuerySchema,
  adminUserListQuerySchema,
  blockUserRequestSchema,
  setGlobalAdminRequestSchema,
  suspendTenantRequestSchema,
} from '@gmgo/shared/admin'
import { resolveCookieAuth } from '../middleware/auth'
import {
  decideAccessRequest,
  enterSupport,
  getAdminTenant,
  getAdminUser,
  leaveSupport,
  listAccessRequests,
  listAdminTenants,
  listAdminUsers,
  setGlobalAdmin,
  setTenantSuspended,
  setUserBlocked,
} from '../services/admin'
import { buildSessionResponse } from '../services/auth'
import { ForbiddenError, UnauthorizedError } from '../utils/core/errors'
import { paginated } from '../utils/routes/pagination'
import { requireMultiTenant, uuidParam, withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const adminRouter = createRouter()

// ---- Access requests ------------------------------------------------------------------------

adminRouter.get('/access-requests', validate('query', accessRequestListQuerySchema), async c => {
  const { db } = withAuth(c)
  const query = c.req.valid('query')
  const { items, total } = await listAccessRequests(db, query)
  return c.json(paginated(items, total, query))
})

adminRouter.post(
  '/access-requests/:id/decide',
  validate('json', decideAccessRequestSchema),
  async c => {
    const { db, cfg, logger, user } = withAuth(c)
    const decision = c.req.valid('json')
    if (decision.decision === 'approve' && decision.approve.mode === 'new_org')
      requireMultiTenant(cfg)
    const result = await decideAccessRequest(db, cfg, logger, c.env.JOBS_QUEUE, {
      id: uuidParam(c, 'id'),
      decision,
      admin: user,
    })
    return c.json(result)
  }
)

// ---- Tenants --------------------------------------------------------------------------------

adminRouter.get('/tenants', validate('query', adminTenantListQuerySchema), async c => {
  const { db, cfg } = withAuth(c)
  requireMultiTenant(cfg)
  const query = c.req.valid('query')
  const { items, total } = await listAdminTenants(db, query)
  return c.json(paginated(items, total, query))
})

adminRouter.get('/tenants/:id', async c => {
  const { db, user } = withAuth(c)
  return c.json(await getAdminTenant(db, uuidParam(c, 'id'), user.id))
})

adminRouter.post('/tenants/:id/suspend', validate('json', suspendTenantRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const row = await setTenantSuspended(db, uuidParam(c, 'id'), c.req.valid('json').suspended, user)
  return c.json({ id: row.id, status: row.status })
})

adminRouter.post('/tenants/:id/support/enter', async c => {
  const { db, cfg, user, auth } = withAuth(c)
  await enterSupport(db, uuidParam(c, 'id'), user, auth.session.id)
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})

adminRouter.post('/tenants/:id/support/leave', async c => {
  const { db, cfg, user, auth } = withAuth(c)
  await leaveSupport(db, uuidParam(c, 'id'), user, auth.session.id)
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})

// ---- Users ----------------------------------------------------------------------------------

adminRouter.get('/users', validate('query', adminUserListQuerySchema), async c => {
  const { db } = withAuth(c)
  const query = c.req.valid('query')
  const { items, total } = await listAdminUsers(db, query)
  return c.json(paginated(items, total, query))
})

adminRouter.get('/users/:id', async c => {
  const { db } = withAuth(c)
  return c.json(await getAdminUser(db, uuidParam(c, 'id')))
})

adminRouter.post(
  '/users/:id/global-admin',
  validate('json', setGlobalAdminRequestSchema),
  async c => {
    const { db, user } = withAuth(c)
    const updated = await setGlobalAdmin(db, {
      userId: uuidParam(c, 'id'),
      isGlobalAdmin: c.req.valid('json').isGlobalAdmin,
      actor: user,
    })
    return c.json({ id: updated.id, isGlobalAdmin: updated.isGlobalAdmin })
  }
)

adminRouter.post('/users/:id/block', validate('json', blockUserRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const id = uuidParam(c, 'id')
  if (id === user.id) throw new ForbiddenError('You cannot block yourself')
  const updated = await setUserBlocked(db, { userId: id, blocked: c.req.valid('json').blocked })
  return c.json({ id: updated.id, blockedAt: updated.blockedAt })
})
