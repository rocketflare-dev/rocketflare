/**
 * Groups (D29) — group types, groups and membership, plus the two queries the rest of the app
 * needs from them: `listUserGroups` (what the auth context carries) and `groupsForMembers` (the
 * People list's badges, in ONE query rather than one per group).
 *
 * Every function takes a `tenantId` and every query names it. Group ids that arrive from a client
 * are validated against the tenant before they are stored anywhere — `assertGroupsInTenant` is the
 * one place that happens, so a grant can never point at another organisation's group.
 */
import type {
  Group,
  GroupDetail,
  GroupMember,
  GroupRef,
  GroupType,
} from '@rocketflare/shared/groups'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import {
  analyticsPageGroups,
  documentGroups,
  groupMembers,
  groups,
  groupTypes,
  tenantUsers,
  users,
} from '../../db/schema'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/core/errors'

/** `23505` — a duplicate name under the tenant's unique constraint. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

// ---- Group types -----------------------------------------------------------------------------

export async function listGroupTypes(db: Database, tenantId: string): Promise<GroupType[]> {
  const rows = await db
    .select({
      id: groupTypes.id,
      tenantId: groupTypes.tenantId,
      name: groupTypes.name,
      description: groupTypes.description,
      createdAt: groupTypes.createdAt,
      updatedAt: groupTypes.updatedAt,
      groupCount: sql<number>`(select count(*) from ${groups} where ${groups.groupTypeId} = ${groupTypes.id})`,
    })
    .from(groupTypes)
    .where(eq(groupTypes.tenantId, tenantId))
    .orderBy(asc(groupTypes.name))
  return rows.map(row => ({ ...row, groupCount: Number(row.groupCount) }))
}

export async function createGroupType(
  db: Database,
  tenantId: string,
  input: { name: string; description?: string | null }
): Promise<GroupType> {
  const [row] = await db
    .insert(groupTypes)
    .values({ tenantId, name: input.name, description: input.description ?? null })
    .returning()
    .catch(err => {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A group type called "${input.name}" already exists`,
          'group_type_exists'
        )
      }
      throw err
    })
  if (!row) throw new Error('group_types: insert returned no row')
  return { ...row, groupCount: 0 }
}

export async function updateGroupType(
  db: Database,
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string | null }
): Promise<GroupType> {
  const [row] = await db
    .update(groupTypes)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
    })
    .where(and(eq(groupTypes.id, id), eq(groupTypes.tenantId, tenantId)))
    .returning()
    .catch(err => {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A group type called "${patch.name}" already exists`,
          'group_type_exists'
        )
      }
      throw err
    })
  if (!row) throw new NotFoundError('Group type not found')
  const [n] = await db
    .select({ n: count() })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.groupTypeId, id)))
  return { ...row, groupCount: n?.n ?? 0 }
}

// ---- Groups ----------------------------------------------------------------------------------

const groupSelect = {
  id: groups.id,
  tenantId: groups.tenantId,
  groupTypeId: groups.groupTypeId,
  typeName: groupTypes.name,
  name: groups.name,
  description: groups.description,
  createdAt: groups.createdAt,
  updatedAt: groups.updatedAt,
  memberCount: sql<number>`(select count(*) from ${groupMembers} where ${groupMembers.groupId} = ${groups.id})`,
}

const toGroup = (row: Record<string, unknown>): Group =>
  ({ ...row, memberCount: Number(row.memberCount) }) as Group

export async function listGroups(
  db: Database,
  tenantId: string,
  filter: { typeId?: string } = {}
): Promise<Group[]> {
  const rows = await db
    .select(groupSelect)
    .from(groups)
    .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
    .where(
      and(
        eq(groups.tenantId, tenantId),
        filter.typeId ? eq(groups.groupTypeId, filter.typeId) : undefined
      )
    )
    .orderBy(asc(groupTypes.name), asc(groups.name))
  return rows.map(toGroup)
}

export async function getGroup(db: Database, tenantId: string, id: string): Promise<GroupDetail> {
  const [row] = await db
    .select(groupSelect)
    .from(groups)
    .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
    .where(and(eq(groups.id, id), eq(groups.tenantId, tenantId)))
    .limit(1)
  if (!row) throw new NotFoundError('Group not found')
  return { ...toGroup(row), members: await listGroupMembers(db, tenantId, id) }
}

export async function listGroupMembers(
  db: Database,
  tenantId: string,
  groupId: string
): Promise<GroupMember[]> {
  return db
    .select({
      userId: groupMembers.userId,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      addedAt: groupMembers.createdAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.groupId, groupId)))
    .orderBy(asc(users.name))
}

export async function createGroup(
  db: Database,
  tenantId: string,
  input: { groupTypeId: string; name: string; description?: string | null }
): Promise<Group> {
  const type = await db.query.groupTypes.findFirst({
    where: and(eq(groupTypes.id, input.groupTypeId), eq(groupTypes.tenantId, tenantId)),
  })
  if (!type) throw new NotFoundError('Group type not found')
  const [row] = await db
    .insert(groups)
    .values({
      tenantId,
      groupTypeId: input.groupTypeId,
      name: input.name,
      description: input.description ?? null,
    })
    .returning()
    .catch(err => {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A group called "${input.name}" already exists in ${type.name}`,
          'group_exists'
        )
      }
      throw err
    })
  if (!row) throw new Error('groups: insert returned no row')
  return { ...row, typeName: type.name, memberCount: 0 }
}

export async function updateGroup(
  db: Database,
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string | null }
): Promise<Group> {
  const [row] = await db
    .update(groups)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
    })
    .where(and(eq(groups.id, id), eq(groups.tenantId, tenantId)))
    .returning({ id: groups.id })
    .catch(err => {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A group called "${patch.name}" already exists in that type`,
          'group_exists'
        )
      }
      throw err
    })
  if (!row) throw new NotFoundError('Group not found')
  return getGroup(db, tenantId, id)
}

// ---- Deleting, and what it costs --------------------------------------------------------------

export interface GroupUsage {
  documents: number
  dashboards: number
}

/** What a group still grants. The delete route quotes these numbers in its 409. */
export async function countGroupGrants(
  db: Database,
  tenantId: string,
  groupIds: string[]
): Promise<GroupUsage> {
  if (groupIds.length === 0) return { documents: 0, dashboards: 0 }
  const [[docs], [pages]] = await Promise.all([
    db
      .select({ n: count() })
      .from(documentGroups)
      .where(and(eq(documentGroups.tenantId, tenantId), inArray(documentGroups.groupId, groupIds))),
    db
      .select({ n: count() })
      .from(analyticsPageGroups)
      .where(
        and(
          eq(analyticsPageGroups.tenantId, tenantId),
          inArray(analyticsPageGroups.groupId, groupIds)
        )
      ),
  ])
  return { documents: docs?.n ?? 0, dashboards: pages?.n ?? 0 }
}

export async function groupIdsOfType(
  db: Database,
  tenantId: string,
  groupTypeId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.groupTypeId, groupTypeId)))
  return rows.map(r => r.id)
}

/**
 * Deleting a group deletes its grants by cascade, and the resources that were restricted to it
 * KEEP `visibility: 'groups'` — so they become owner-and-admins-only rather than tenant-wide.
 * That fail-closed direction is the whole reason `visibility` is a column.
 */
export async function deleteGroup(db: Database, tenantId: string, id: string): Promise<void> {
  const rows = await db
    .delete(groups)
    .where(and(eq(groups.id, id), eq(groups.tenantId, tenantId)))
    .returning({ id: groups.id })
  if (rows.length === 0) throw new NotFoundError('Group not found')
}

export async function deleteGroupType(db: Database, tenantId: string, id: string): Promise<void> {
  const rows = await db
    .delete(groupTypes)
    .where(and(eq(groupTypes.id, id), eq(groupTypes.tenantId, tenantId)))
    .returning({ id: groupTypes.id })
  if (rows.length === 0) throw new NotFoundError('Group type not found')
}

// ---- Membership -------------------------------------------------------------------------------

/** Every id must name a group of THIS tenant; otherwise 400. Returns them in a stable order. */
export async function assertGroupsInTenant(
  db: Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(groupIds)]
  if (unique.length === 0) return []
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), inArray(groups.id, unique)))
  if (rows.length !== unique.length) {
    const found = new Set(rows.map(r => r.id))
    throw new BadRequestError('Every group must belong to this organisation', 'unknown_group', {
      groupIds: unique.filter(id => !found.has(id)),
    })
  }
  return rows.map(r => r.id)
}

/** Every user id must be a member of THIS tenant; otherwise 400. */
export async function assertTenantMembers(
  db: Database,
  tenantId: string,
  userIds: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return []
  const rows = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), inArray(tenantUsers.userId, unique)))
  if (rows.length !== unique.length) {
    const found = new Set(rows.map(r => r.userId))
    throw new BadRequestError(
      'Every person must already be a member of this organisation',
      'not_a_member',
      { userIds: unique.filter(id => !found.has(id)) }
    )
  }
  return rows.map(r => r.userId)
}

export async function addGroupMembers(
  db: Database,
  tenantId: string,
  groupId: string,
  userIds: string[]
): Promise<void> {
  if (userIds.length === 0) return
  await db
    .insert(groupMembers)
    .values(userIds.map(userId => ({ tenantId, groupId, userId })))
    .onConflictDoNothing()
}

export async function removeGroupMember(
  db: Database,
  tenantId: string,
  groupId: string,
  userId: string
): Promise<void> {
  await db
    .delete(groupMembers)
    .where(
      and(
        eq(groupMembers.tenantId, tenantId),
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, userId)
      )
    )
}

/** Everyone in any of these groups — who to nudge when the groups are about to vanish. */
export async function membersOfGroups(
  db: Database,
  tenantId: string,
  groupIds: string[]
): Promise<string[]> {
  if (groupIds.length === 0) return []
  const rows = await db
    .selectDistinct({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), inArray(groupMembers.groupId, groupIds)))
  return rows.map(r => r.userId)
}

/** Replace ONE member's groups wholesale (the People page's "Edit groups"). */
export async function setMemberGroups(
  db: Database,
  tenantId: string,
  userId: string,
  groupIds: string[]
): Promise<void> {
  await db.transaction(async tx => {
    await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
    if (groupIds.length > 0) {
      await tx
        .insert(groupMembers)
        .values(groupIds.map(groupId => ({ tenantId, groupId, userId })))
        .onConflictDoNothing()
    }
  })
}

// ---- Reads the rest of the app needs -----------------------------------------------------------

/**
 * One person's groups in one tenant. The cookie path gets this from `resolveSession`'s LATERAL
 * join; the Bearer path calls it, so a tenant API key carries its CREATOR's groups, re-read on
 * every request — removing someone from a group narrows their keys on the next call, with nothing
 * to revoke.
 */
export async function listUserGroups(
  db: Database,
  tenantId: string,
  userId: string
): Promise<GroupRef[]> {
  return db
    .select({ id: groups.id, name: groups.name, typeName: groupTypes.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
    .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, userId)))
    .orderBy(asc(groupTypes.name), asc(groups.name))
}

/**
 * Groups for MANY members in one query — what the People list renders. The app this was ported
 * from fetched the member list once per group, which is N+1 in the number of groups.
 */
export async function groupsForMembers(
  db: Database,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, GroupRef[]>> {
  const out = new Map<string, GroupRef[]>()
  if (userIds.length === 0) return out
  const rows = await db
    .select({
      userId: groupMembers.userId,
      id: groups.id,
      name: groups.name,
      typeName: groupTypes.name,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
    .where(and(eq(groupMembers.tenantId, tenantId), inArray(groupMembers.userId, userIds)))
    .orderBy(asc(groupTypes.name), asc(groups.name))
  for (const row of rows) {
    const list = out.get(row.userId) ?? []
    list.push({ id: row.id, name: row.name, typeName: row.typeName })
    out.set(row.userId, list)
  }
  return out
}
