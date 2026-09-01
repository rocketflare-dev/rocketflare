/**
 * `POST /api/access-requests` (D9): a signed-in user with no organisation asks to be let in.
 * Tenant-free; the email is always the session user's (the body's is ignored when signed in).
 * Creates or updates the ONE pending request for that address.
 */
import { createAccessRequestSchema } from '@rocketflare/shared/access-requests'
import { ensureAccessRequest } from '../services/auth'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const accessRequestsRouter = createRouter()

accessRequestsRouter.post('/', validate('json', createAccessRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const body = c.req.valid('json')
  const row = await ensureAccessRequest(db, {
    email: user.email,
    userId: user.id,
    message: body.message ?? null,
    requestedTenantId: body.requestedTenantId ?? null,
  })
  return c.json(
    {
      id: row.id,
      email: row.email,
      userId: row.userId,
      requestedTenantId: row.requestedTenantId,
      message: row.message,
      status: row.status,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    },
    201
  )
})
