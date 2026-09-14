/**
 * `/api/members` (D10): list (every member may read; `support` rows included), role change and
 * removal (`manage TenantMember`, with the ownership invariants enforced in services/members.ts).
 * `PUT /:userId/groups` replaces one member's groups wholesale (D29, `manage Group`) — the People
 * page's "Edit groups", and the one place membership is edited from the person rather than from
 * the group.
 */

import { setMemberGroupsRequestSchema } from '@rocketflare/shared/groups'
import { paginationQuerySchema } from '@rocketflare/shared/pagination'
import { updateMemberRoleRequestSchema } from '@rocketflare/shared/tenants'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  assertGroupsInTenant,
  assertTenantMembers,
  listUserGroups,
  setMemberGroups,
} from '../services/groups'
import { changeMemberRole, listMembers, removeMember } from '../services/members'
import { nudge, nudgeUsers, realtimeEvent } from '../services/realtime'
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
  const { db, tenantId, auth, realtime } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'TenantMember')
  const membership = await changeMemberRole(db, {
    tenantId,
    targetUserId: uuidParam(c, 'userId'),
    role: c.req.valid('json').role,
    actor: auth,
    realtime,
  })
  return c.json({ userId: membership.userId, role: membership.role })
})

membersRouter.delete('/:userId', async c => {
  const { db, tenantId, auth, realtime } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'TenantMember')
  await removeMember(db, {
    tenantId,
    targetUserId: uuidParam(c, 'userId'),
    actor: auth,
    realtime,
  })
  return c.body(null, 204)
})

membersRouter.put('/:userId/groups', validate('json', setMemberGroupsRequestSchema), async c => {
  const { db, tenantId, user, realtime, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const targetUserId = uuidParam(c, 'userId')
  await assertTenantMembers(db, tenantId, [targetUserId])
  const groupIds = await assertGroupsInTenant(db, tenantId, c.req.valid('json').groupIds)
  await setMemberGroups(db, tenantId, targetUserId, groupIds)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.member_changed',
      subjectType: 'TenantMember',
      subjectId: targetUserId,
      metadata: { groupIds },
    })
  )
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'groups' }))
  nudge(realtime, realtimeEvent('member.changed', tenantId, { id: targetUserId }))
  // What this person may READ has moved under them — their own tabs need to know.
  nudgeUsers(realtime, [targetUserId], realtimeEvent('access.changed', tenantId))
  return c.json({ items: await listUserGroups(db, tenantId, targetUserId) })
})
