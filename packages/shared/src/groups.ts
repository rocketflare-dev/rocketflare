/**
 * Groups and resource visibility (D29). A tenant defines GROUP TYPES ("Department", "Region",
 * "Client"), each holding GROUPS, each holding tenant members. Group membership is part of the
 * auth context and drives who can READ a document or a dashboard.
 *
 * Two rules the shapes here encode, both learned from the app this was ported from:
 *
 * - **Visibility is an explicit column, not the absence of grants.** `visibility: 'tenant'` means
 *   everyone in the organisation; `'groups'` means only the listed groups. Deleting the last group
 *   a resource was restricted to therefore leaves it `groups` with an EMPTY list — visible to its
 *   owner and to admins and to nobody else. Inferring "restricted" from "has grant rows" makes
 *   that same delete silently publish the resource to the whole tenant.
 * - **Group membership grants READ only.** Editing a document or a dashboard stays with its owner
 *   and with admins, exactly as before Groups existed.
 */
import { z } from 'zod'

export const GROUP_NAME_MAX = 100
export const GROUP_DESCRIPTION_MAX = 500
/** How many members may be added to a group in one call. */
export const GROUP_MEMBERS_MAX = 200

// ---- Group types ---------------------------------------------------------------------------

export const groupTypeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Groups declared under this type — present on the list, so the UI needs no second call. */
  groupCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type GroupType = z.infer<typeof groupTypeSchema>

export const groupTypeNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX)
const descriptionSchema = z.string().trim().max(GROUP_DESCRIPTION_MAX).nullable().optional()

export const createGroupTypeRequestSchema = z.object({
  name: groupTypeNameSchema,
  description: descriptionSchema,
})
export type CreateGroupTypeRequest = z.infer<typeof createGroupTypeRequestSchema>

export const updateGroupTypeRequestSchema = z
  .object({
    name: groupTypeNameSchema,
    description: z.string().trim().max(GROUP_DESCRIPTION_MAX).nullable(),
  })
  .partial()
  .refine(v => Object.keys(v).length > 0, 'At least one field must be provided')
export type UpdateGroupTypeRequest = z.infer<typeof updateGroupTypeRequestSchema>

export const groupTypeListResponseSchema = z.object({ items: z.array(groupTypeSchema) })
export type GroupTypeListResponse = z.infer<typeof groupTypeListResponseSchema>

// ---- Groups --------------------------------------------------------------------------------

export const groupSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  groupTypeId: z.string().uuid(),
  /** The type's name, so a group renders as "Finance (Department)" without a second query. */
  typeName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Group = z.infer<typeof groupSchema>

export const createGroupRequestSchema = z.object({
  groupTypeId: z.string().uuid(),
  name: groupTypeNameSchema,
  description: descriptionSchema,
})
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>

export const updateGroupRequestSchema = z
  .object({
    name: groupTypeNameSchema,
    description: z.string().trim().max(GROUP_DESCRIPTION_MAX).nullable(),
  })
  .partial()
  .refine(v => Object.keys(v).length > 0, 'At least one field must be provided')
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>

export const groupListQuerySchema = z.object({ typeId: z.string().uuid().optional() })
export type GroupListQuery = z.infer<typeof groupListQuerySchema>

export const groupListResponseSchema = z.object({ items: z.array(groupSchema) })
export type GroupListResponse = z.infer<typeof groupListResponseSchema>

// ---- Members -------------------------------------------------------------------------------

export const groupMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  addedAt: z.coerce.date(),
})
export type GroupMember = z.infer<typeof groupMemberSchema>

/** `GET /api/groups/:id` — the group plus who is in it. */
export const groupDetailSchema = groupSchema.extend({ members: z.array(groupMemberSchema) })
export type GroupDetail = z.infer<typeof groupDetailSchema>

export const addGroupMembersRequestSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(GROUP_MEMBERS_MAX),
})
export type AddGroupMembersRequest = z.infer<typeof addGroupMembersRequestSchema>

/** A member's groups, as they appear on the People list and in the auth context. */
export const groupRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  typeName: z.string(),
})
export type GroupRef = z.infer<typeof groupRefSchema>

/** `GET /api/groups/mine` — what the signed-in user belongs to, for their profile. */
export const myGroupsSchema = z.object({ items: z.array(groupRefSchema) })
export type MyGroups = z.infer<typeof myGroupsSchema>

/** `PUT /api/members/:userId/groups` — the member's group ids, replaced wholesale. */
export const setMemberGroupsRequestSchema = z.object({
  groupIds: z.array(z.string().uuid()).max(GROUP_MEMBERS_MAX),
})
export type SetMemberGroupsRequest = z.infer<typeof setMemberGroupsRequestSchema>

// ---- Resource visibility --------------------------------------------------------------------

/**
 * `tenant` = everyone in the organisation; `groups` = only the listed groups (plus the owner and
 * admins). An EMPTY `groups` list is legal and means "only the owner and admins" — it is what a
 * force-deleted group leaves behind, and it fails closed on purpose.
 */
export const resourceVisibilitySchema = z.enum(['tenant', 'groups'])
export type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>

export const setVisibilityRequestSchema = z
  .object({
    visibility: resourceVisibilitySchema,
    groupIds: z.array(z.string().uuid()).max(GROUP_MEMBERS_MAX).default([]),
  })
  .refine(v => v.visibility === 'groups' || v.groupIds.length === 0, {
    message: 'groupIds is only meaningful with visibility "groups"',
    path: ['groupIds'],
  })
export type SetVisibilityRequest = z.infer<typeof setVisibilityRequestSchema>

/** What every visibility-carrying resource reports: the mode and the groups it is shared with. */
export const resourceAccessSchema = z.object({
  visibility: resourceVisibilitySchema,
  groups: z.array(groupRefSchema),
})
export type ResourceAccess = z.infer<typeof resourceAccessSchema>

/** True when the selection leaves nobody but the owner and admins — the UI warns about it. */
export function isPrivateSelection(visibility: ResourceVisibility, groupIds: readonly string[]) {
  return visibility === 'groups' && groupIds.length === 0
}
