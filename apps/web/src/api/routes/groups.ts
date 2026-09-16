/**
 * `/api/groups` (D29) — group types, groups and their membership.
 *
 *   GET    /types                      manage Group
 *   POST   /types                      manage Group
 *   PATCH  /types/:id                  manage Group
 *   DELETE /types/:id[?force=1]        manage Group — 409 `group_in_use` while it still grants
 *   GET    /            ?typeId=       manage Group
 *   POST   /                           manage Group
 *   GET    /:id                        manage Group — with members
 *   PATCH  /:id                        manage Group
 *   DELETE /:id[?force=1]              manage Group — 409 `group_in_use` while it still grants
 *   POST   /:id/members { userIds }    manage Group — every id must already be a tenant member
 *   DELETE /:id/members/:userId        manage Group
 *   GET    /mine                       any member — what the caller belongs to
 *
 * Administering groups is admin+ throughout; a member's only read is their OWN groups. Deleting
 * something that still grants access is refused rather than quietly changing who can see what —
 * and `?force=1` is fail-CLOSED: the affected documents and dashboards keep `visibility: 'groups'`
 * with fewer grants, so they narrow to their owner and to admins. They never become tenant-wide.
 */
import {
  addGroupMembersRequestSchema,
  createGroupRequestSchema,
  createGroupTypeRequestSchema,
  groupListQuerySchema,
  updateGroupRequestSchema,
  updateGroupTypeRequestSchema,
} from '@rocketflare/shared/groups'
import { guardPermission } from '../middleware/permissions'
import { countGroupGrants, VISIBILITY_RESOURCES } from '../services/access'
import { recordActivity } from '../services/activity'
import {
  addGroupMembers,
  assertTenantMembers,
  createGroup,
  createGroupType,
  deleteGroup,
  deleteGroupType,
  getGroup,
  groupIdsOfType,
  listGroups,
  listGroupTypes,
  listUserGroups,
  membersOfGroups,
  removeGroupMember,
  updateGroup,
  updateGroupType,
} from '../services/groups'
import { nudge, nudgeUsers, realtimeEvent } from '../services/realtime'
import type { AppContext } from '../types'
import { ConflictError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const groupsRouter = createRouter()

/** The admin UI's query-key root; `access.changed` is what a person whose access moved gets. */
const GROUPS_ENTITY = 'groups'

function nudgeGroups(c: AppContext, tenantId: string, id?: string) {
  const { realtime } = withAuthAndDb(c)
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: GROUPS_ENTITY, ...(id && { id }) })
  )
}

/**
 * People whose visible content just changed. `access.changed` invalidates auth, documents,
 * dashboards and groups on their tabs, so a person who loses a group watches the content go rather
 * than clicking into a 404.
 */
function nudgeAccessChanged(c: AppContext, tenantId: string, userIds: string[]) {
  const { realtime } = withAuthAndDb(c)
  nudgeUsers(realtime, userIds, realtimeEvent('access.changed', tenantId))
}

// ---- Mine (every member) ------------------------------------------------------------------

groupsRouter.get('/mine', async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  return c.json({ items: await listUserGroups(db, tenantId, user.id) })
})

// ---- Group types --------------------------------------------------------------------------

groupsRouter.get('/types', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  return c.json({ items: await listGroupTypes(db, tenantId) })
})

groupsRouter.post('/types', validate('json', createGroupTypeRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const row = await createGroupType(db, tenantId, c.req.valid('json'))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group_type.created',
      subjectType: 'Group',
      subjectId: row.id,
      metadata: { name: row.name },
    })
  )
  nudgeGroups(c, tenantId)
  return c.json(row, 201)
})

groupsRouter.patch('/types/:id', validate('json', updateGroupTypeRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  const row = await updateGroupType(db, tenantId, id, c.req.valid('json'))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group_type.updated',
      subjectType: 'Group',
      subjectId: id,
      metadata: { name: row.name },
    })
  )
  nudgeGroups(c, tenantId, id)
  return c.json(row)
})

groupsRouter.delete('/types/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  const groupIds = await groupIdsOfType(db, tenantId, id)
  await refuseWhileInUse(c, db, tenantId, groupIds, 'group type')
  const affected = await membersOfGroups(db, tenantId, groupIds)
  await deleteGroupType(db, tenantId, id)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group_type.deleted',
      subjectType: 'Group',
      subjectId: id,
      metadata: { groups: groupIds.length },
    })
  )
  nudgeGroups(c, tenantId)
  nudgeAccessChanged(c, tenantId, affected)
  return c.body(null, 204)
})

// ---- Groups -------------------------------------------------------------------------------

groupsRouter.get('/', validate('query', groupListQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  return c.json({ items: await listGroups(db, tenantId, c.req.valid('query')) })
})

groupsRouter.post('/', validate('json', createGroupRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const row = await createGroup(db, tenantId, c.req.valid('json'))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.created',
      subjectType: 'Group',
      subjectId: row.id,
      metadata: { name: row.name, typeName: row.typeName },
    })
  )
  nudgeGroups(c, tenantId)
  return c.json(row, 201)
})

groupsRouter.get('/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  return c.json(await getGroup(db, tenantId, uuidParam(c, 'id')))
})

groupsRouter.patch('/:id', validate('json', updateGroupRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  const row = await updateGroup(db, tenantId, id, c.req.valid('json'))
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.updated',
      subjectType: 'Group',
      subjectId: id,
      metadata: { name: row.name },
    })
  )
  nudgeGroups(c, tenantId, id)
  return c.json(row)
})

groupsRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  const group = await getGroup(db, tenantId, id)
  await refuseWhileInUse(c, db, tenantId, [id], 'group')
  const affected = group.members.map(m => m.userId)
  await deleteGroup(db, tenantId, id)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.deleted',
      subjectType: 'Group',
      subjectId: id,
      metadata: { name: group.name, typeName: group.typeName },
    })
  )
  nudgeGroups(c, tenantId)
  nudgeAccessChanged(c, tenantId, affected)
  return c.body(null, 204)
})

// ---- Membership ---------------------------------------------------------------------------

groupsRouter.post('/:id/members', validate('json', addGroupMembersRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  await getGroup(db, tenantId, id)
  const userIds = await assertTenantMembers(db, tenantId, c.req.valid('json').userIds)
  await addGroupMembers(db, tenantId, id, userIds)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.member_added',
      subjectType: 'Group',
      subjectId: id,
      metadata: { userIds },
    })
  )
  nudgeGroups(c, tenantId, id)
  nudgeAccessChanged(c, tenantId, userIds)
  return c.json(await getGroup(db, tenantId, id))
})

groupsRouter.delete('/:id/members/:userId', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Group')
  const id = uuidParam(c, 'id')
  const targetUserId = uuidParam(c, 'userId')
  await getGroup(db, tenantId, id)
  await removeGroupMember(db, tenantId, id, targetUserId)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'group.member_removed',
      subjectType: 'Group',
      subjectId: id,
      metadata: { userId: targetUserId },
    })
  )
  nudgeGroups(c, tenantId, id)
  nudgeAccessChanged(c, tenantId, [targetUserId])
  return c.body(null, 204)
})

// ---- Helpers ------------------------------------------------------------------------------

/** 409 with the counts, unless `?force=1`. Forcing narrows content; it never opens it. */
async function refuseWhileInUse(
  c: AppContext,
  db: ReturnType<typeof withAuthAndDb>['db'],
  tenantId: string,
  groupIds: string[],
  what: string
): Promise<void> {
  if (c.req.query('force') === '1') return
  const usage = await countGroupGrants(db, tenantId, groupIds)
  const total = Object.values(usage).reduce((sum, n) => sum + n, 0)
  if (total === 0) return
  // One clause per registered visibility resource, zeroes included — the sentence says what the
  // whole organisation would lose, not only the parts that happen to be non-empty.
  const held = VISIBILITY_RESOURCES.map(r => `${usage[r.usageKey] ?? 0} ${r.noun}(s)`).join(' and ')
  throw new ConflictError(
    `This ${what} still controls access to ${held}. Deleting it leaves them visible to their owner and to admins only — re-send with ?force=1 to go ahead.`,
    'group_in_use',
    usage
  )
}
