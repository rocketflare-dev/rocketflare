/**
 * `/api/tenants`: `GET` = the caller's tenant summaries (the org switcher), `POST` =
 * create an organisation with the caller as owner and select it — 404 `tenancy_mode_single` in
 * single mode. Tenant-free: a user with no membership must be able to create their first org,
 * unless their access request is pending or rejected. Under IdP-managed tenancy the issuer decides
 * which organisations exist, so self-service creation answers 409 `idp_managed`. A person's owned
 * organisations stop at `MAX_OWNED_TENANTS_PER_USER`. An API key lists only its own organisation
 * and cannot create one (403 `insufficient_scope`): a key acts within the organisation it belongs to.
 */
import { createTenantRequestSchema } from '@rocketflare/shared/tenants'
import { updateSelectedTenant } from '../auth/sessions'
import { isApiKeySession } from '../middleware/auth'
import { operationLock } from '../middleware/rate-limit'
import { listTenantSummaries } from '../services/auth'
import { tenantCreationRefusal, toTenantDto } from '../services/tenants'
import { createTenantForUser } from '../utils/db/tenant-helpers'
import { requireMultiTenant, withAccountAuth, withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const tenantsRouter = createRouter()

tenantsRouter.get('/', async c => {
  const { db, user, auth } = withAuth(c)
  const summaries = await listTenantSummaries(db, user.id)
  if (isApiKeySession(auth)) return c.json(summaries.filter(t => t.id === auth.tenantId))
  return c.json(summaries)
})

tenantsRouter.post('/', validate('json', createTenantRequestSchema), async c => {
  const { db, cfg, user, auth } = withAccountAuth(c)
  requireMultiTenant(cfg)
  const refusal = tenantCreationRefusal(cfg, auth)
  if (refusal) throw refusal
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
  await updateSelectedTenant(db, auth.session.id, tenant.id)
  return c.json(toTenantDto(tenant), 201)
})
