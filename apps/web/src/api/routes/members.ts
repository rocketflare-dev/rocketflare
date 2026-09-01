/**
 * `/api/members` (D10): list (every member may read; `support` rows included), role change and
 * removal (`manage TenantMember`, with the ownership invariants enforced in services/members.ts).
 */
import { paginationQuerySchema } from '@gmgo/shared/pagination'
import { updateMemberRoleRequestSchema } from '@gmgo/shared/tenants'
import { guardPermission } from '../middleware/permissions'
import { changeMemberRole, listMembers, removeMember } from '../services/members'
import { paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const membersRouter = createRouter()

membersRouter.get('/', validate('query', paginationQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'TenantMember')
  const query = c.req.valid('query')
  const { items, total } = await listMembers(db, tenantId, query)
  return c.json(paginated(items, total, query))
})

membersRouter.patch('/:userId', validate('json', updateMemberRoleRequestSchema), async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'TenantMember')
  const membership = await changeMemberRole(db, {
    tenantId,
    targetUserId: uuidParam(c, 'userId'),
    role: c.req.valid('json').role,
    actor: auth,
  })
  return c.json({ userId: membership.userId, role: membership.role })
})

membersRouter.delete('/:userId', async c => {
  const { db, tenantId, auth } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'TenantMember')
  await removeMember(db, { tenantId, targetUserId: uuidParam(c, 'userId'), actor: auth })
  return c.body(null, 204)
})
