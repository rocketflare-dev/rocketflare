/**
 * The CURRENT tenant: `/api/tenant` (read admin+/owner writes, owner-only delete with slug
 * confirmation — 404 `tenancy_mode_single` in single mode) and `/api/tenant/settings` (D10, D25).
 */
import { updateTenantSettingsRequestSchema } from '@rocketflare/shared/tenant-settings'
import { deleteTenantRequestSchema, updateTenantRequestSchema } from '@rocketflare/shared/tenants'
import { guardOwner, guardPermission, isAdminLevel } from '../middleware/permissions'
import { operationLock } from '../middleware/rate-limit'
import { recordActivity } from '../services/activity'
import {
  deleteTenant,
  getTenant,
  getTenantSettings,
  updateTenant,
  updateTenantSettings,
} from '../services/tenants'
import { BadRequestError, ForbiddenError } from '../utils/core/errors'
import { requireMultiTenant, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const tenantRouter = createRouter()

tenantRouter.get('/', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Tenant')
  return c.json(await getTenant(db, tenantId))
})

tenantRouter.patch('/', validate('json', updateTenantRequestSchema), async c => {
  const { db, tenantId, auth, user, defer, realtime } = withAuthAndDb(c)
  const patch = c.req.valid('json')
  if (!isAdminLevel(auth)) throw new ForbiddenError('Only admins can update the organisation')
  if (patch.slug !== undefined) guardOwner(c)
  const tenant = await updateTenant(db, tenantId, patch, realtime)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'tenant.updated',
      subjectType: 'Tenant',
      subjectId: tenantId,
      metadata: { ...patch },
    })
  )
  return c.json(tenant)
})

tenantRouter.delete('/', validate('json', deleteTenantRequestSchema), async c => {
  const { db, tenantId, cfg, realtime } = withAuthAndDb(c)
  requireMultiTenant(cfg)
  guardOwner(c)
  const tenant = await getTenant(db, tenantId)
  if (c.req.valid('json').confirm !== tenant.slug) {
    throw new BadRequestError(
      'Type the organisation slug to confirm deletion',
      'confirmation_mismatch'
    )
  }
  await operationLock(c.env.RATE_LIMIT_KV, `tenant:delete:${tenantId}`, () =>
    deleteTenant(db, tenantId, realtime)
  )
  return c.body(null, 204)
})

tenantRouter.get('/settings', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Tenant')
  return c.json(await getTenantSettings(db, tenantId))
})

tenantRouter.patch('/settings', validate('json', updateTenantSettingsRequestSchema), async c => {
  const { db, tenantId, auth, user, defer } = withAuthAndDb(c)
  if (!isAdminLevel(auth)) throw new ForbiddenError('Only admins can update settings')
  const settings = await updateTenantSettings(db, tenantId, c.req.valid('json'))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'tenant.settings_updated',
      subjectType: 'Tenant',
      subjectId: tenantId,
    })
  )
  return c.json(settings)
})
