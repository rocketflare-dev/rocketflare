/**
 * `/api/tenants`: `GET` = the caller's tenant summaries (the org switcher), `POST` =
 * create an organisation with the caller as owner and select it — 404 `tenancy_mode_single` in
 * single mode. Tenant-free: a user with no membership must be able to create their first org,
 * unless their access request is pending or rejected. Under IdP-managed tenancy the issuer decides
 * which organisations exist, so self-service creation answers 409 `idp_managed`. A person's owned
 * organisations stop at `MAX_OWNED_TENANTS_PER_USER`.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { createTenantRequestSchema } from '@rocketflare/shared/tenants'
import { isIdpManaged } from '../../config'
import { updateSelectedTenant } from '../auth/sessions'
import { isApiKeySession } from '../middleware/auth'
import { operationLock } from '../middleware/rate-limit'
import { listTenantSummaries } from '../services/auth'
import { toTenantDto } from '../services/tenants'
import { ConflictError, ForbiddenError } from '../utils/core/errors'
import { createTenantForUser } from '../utils/db/tenant-helpers'
import { requireMultiTenant, withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const tenantsRouter = createRouter()

tenantsRouter.get('/', async c => {
  const { db, user } = withAuth(c)
  return c.json(await listTenantSummaries(db, user.id))
})

tenantsRouter.post('/', validate('json', createTenantRequestSchema), async c => {
  const { db, cfg, user, auth } = withAuth(c)
  requireMultiTenant(cfg)
  if (isIdpManaged(cfg)) {
    throw new ConflictError(
      'Organisations are managed by your identity provider.',
      ERROR_CODES.idpManaged
    )
  }
  if (
    !auth.isGlobalAdmin &&
    auth.tenantId === null &&
    (auth.accessRequestStatus === 'pending' || auth.accessRequestStatus === 'rejected')
  ) {
    throw new ForbiddenError(
      'Your access request has not been approved',
      ERROR_CODES.pendingApproval
    )
  }
  const { name, slug } = c.req.valid('json')
  const tenant = await operationLock(c.env.RATE_LIMIT_KV, `tenant:create:${user.id}`, () =>
    createTenantForUser(db, {
      name,
      slug,
      userId: user.id,
      role: 'owner',
      features: auth.features,
      maxOwnedTenants: auth.isGlobalAdmin ? undefined : cfg.MAX_OWNED_TENANTS_PER_USER,
    })
  )
  if (!isApiKeySession(auth)) await updateSelectedTenant(db, auth.session.id, tenant.id)
  return c.json(toTenantDto(tenant), 201)
})
