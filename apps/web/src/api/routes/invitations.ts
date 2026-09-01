/**
 * `/api/invitations` (D9, D10): pending list (read), create / bulk / resend / revoke (`manage
 * Invitation`), plus the tenant-free `GET /pending` — invitations addressed to MY email across
 * tenants (the login-prologue banner). The public token routes live in `invite.ts`.
 */
import { paginationQuerySchema } from '@rocketflare/shared/pagination'
import { bulkInviteRequestSchema, inviteMemberRequestSchema } from '@rocketflare/shared/tenants'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  bulkInvite,
  createInvitation,
  listInvitations,
  listPendingForEmail,
  resendInvitation,
  revokeInvitation,
} from '../services/invitations'
import { paginated } from '../utils/routes/pagination'
import { uuidParam, withAuth, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const invitationsRouter = createRouter()

// Tenant-free, before `/:id` so "pending" is never parsed as an id.
invitationsRouter.get('/pending', async c => {
  const { db, user } = withAuth(c)
  return c.json({ items: await listPendingForEmail(db, user.email) })
})

invitationsRouter.get('/', validate('query', paginationQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Invitation')
  const query = c.req.valid('query')
  const { items, total } = await listInvitations(db, tenantId, query)
  return c.json(paginated(items, total, query))
})

invitationsRouter.post('/', validate('json', inviteMemberRequestSchema), async c => {
  const { db, cfg, logger, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Invitation')
  const { email, role } = c.req.valid('json')
  const { invitation } = await createInvitation(db, cfg, logger, c.env.JOBS_QUEUE, {
    tenantId,
    email,
    role,
    inviter: user,
    realtime,
  })
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'member.invited',
      subjectType: 'Invitation',
      subjectId: invitation.id,
      metadata: { email, role },
    })
  )
  return c.json(invitation, 201)
})

invitationsRouter.post('/bulk', validate('json', bulkInviteRequestSchema), async c => {
  const { db, cfg, logger, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Invitation')
  const { emails, role } = c.req.valid('json')
  const results = await bulkInvite(db, cfg, logger, c.env.JOBS_QUEUE, {
    tenantId,
    emails,
    role,
    inviter: user,
  })
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'member.bulk_invited',
      subjectType: 'Invitation',
      metadata: {
        invited: results.filter(r => r.status === 'invited').length,
        total: emails.length,
        role,
      },
    })
  )
  return c.json({ results })
})

invitationsRouter.post('/:id/resend', async c => {
  const { db, cfg, logger, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Invitation')
  const id = uuidParam(c, 'id')
  const invitation = await resendInvitation(db, cfg, logger, c.env.JOBS_QUEUE, {
    tenantId,
    id,
    inviter: user,
  })
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'invitation.resent',
      subjectType: 'Invitation',
      subjectId: id,
    })
  )
  return c.json(invitation)
})

invitationsRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Invitation')
  const id = uuidParam(c, 'id')
  await revokeInvitation(db, tenantId, id, realtime)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'invitation.revoked',
      subjectType: 'Invitation',
      subjectId: id,
    })
  )
  return c.body(null, 204)
})
