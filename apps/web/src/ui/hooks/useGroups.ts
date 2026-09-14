/**
 * Groups and resource visibility (D29, D20). Administering groups is admin+ (`manage Group`); the
 * only read a plain member makes here is `useMyGroups` (`GET /api/groups/mine`), which is what the
 * profile shows and what the visibility picker offers them.
 *
 * The family root is `['groups']` on purpose: the server nudges `entity.changed { entity:
 * 'groups' }` from every group mutation and `access.changed` names the same root, so
 * `WebSocketProvider` refreshes this whole area with no socket code in these hooks.
 */

import { documentSchema } from '@rocketflare/shared/ai/embeddings'
import { analyticsPageSchema } from '@rocketflare/shared/analytics'
import {
  type AddGroupMembersRequest,
  type CreateGroupRequest,
  type CreateGroupTypeRequest,
  type Group,
  type GroupDetail,
  type GroupType,
  groupDetailSchema,
  groupListResponseSchema,
  groupTypeListResponseSchema,
  groupTypeSchema,
  myGroupsSchema,
  type ResourceVisibility,
  type SetVisibilityRequest,
  type UpdateGroupRequest,
  type UpdateGroupTypeRequest,
} from '@rocketflare/shared/groups'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

// ---- Reads ------------------------------------------------------------------------------------

export function useGroupTypes(enabled = true) {
  return useQuery({
    queryKey: queryKeys.groups.types,
    queryFn: () => api.get('/api/groups/types', { schema: groupTypeListResponseSchema }),
    enabled,
  })
}

export function useGroups(typeId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groups.list(typeId ? { typeId } : {}),
    queryFn: () =>
      api.get(`/api/groups${typeId ? `?typeId=${typeId}` : ''}`, {
        schema: groupListResponseSchema,
      }),
    enabled,
  })
}

export function useGroup(id: string | null) {
  return useQuery({
    queryKey: queryKeys.groups.detail(id ?? ''),
    queryFn: () => api.get(`/api/groups/${id}`, { schema: groupDetailSchema }),
    enabled: Boolean(id),
  })
}

/** Every member may read their OWN groups — the profile list, and what the picker offers them. */
export function useMyGroups() {
  return useQuery({
    queryKey: queryKeys.groups.mine,
    queryFn: () => api.get('/api/groups/mine', { schema: myGroupsSchema }),
  })
}

// ---- Writes -----------------------------------------------------------------------------------

/** One invalidation covers types, groups and any open detail — they share the `['groups']` root. */
function useGroupsInvalidation() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.groups.all })
}

export function useCreateGroupType() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: (body: CreateGroupTypeRequest) =>
      api.post<GroupType>('/api/groups/types', body, { schema: groupTypeSchema }),
    onSuccess: invalidate,
  })
}

export function useUpdateGroupType() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateGroupTypeRequest & { id: string }) =>
      api.patch<GroupType>(`/api/groups/types/${id}`, body, { schema: groupTypeSchema }),
    onSuccess: invalidate,
  })
}

/**
 * `force` is how the caller answers the 409 the API raises while the type or group still controls
 * access to something — never a default, because the answer narrows what people can see.
 */
export function useDeleteGroupType() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete(`/api/groups/types/${id}${force ? '?force=1' : ''}`),
    onSuccess: invalidate,
  })
}

export function useCreateGroup() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: (body: CreateGroupRequest) => api.post<Group>('/api/groups', body),
    onSuccess: invalidate,
  })
}

export function useUpdateGroup() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateGroupRequest & { id: string }) =>
      api.patch<Group>(`/api/groups/${id}`, body),
    onSuccess: invalidate,
  })
}

export function useDeleteGroup() {
  const invalidate = useGroupsInvalidation()
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete(`/api/groups/${id}${force ? '?force=1' : ''}`),
    onSuccess: invalidate,
  })
}

export function useAddGroupMembers() {
  const invalidate = useGroupsInvalidation()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: AddGroupMembersRequest & { id: string }) =>
      api.post<GroupDetail>(`/api/groups/${id}/members`, body, { schema: groupDetailSchema }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.members.all })
    },
  })
}

export function useRemoveGroupMember() {
  const invalidate = useGroupsInvalidation()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) =>
      api.delete(`/api/groups/${id}/members/${userId}`),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.members.all })
    },
  })
}

/** The People page's "Edit groups": one member's groups, replaced wholesale. */
export function useSetMemberGroups() {
  const invalidate = useGroupsInvalidation()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, groupIds }: { userId: string; groupIds: string[] }) =>
      api.put(`/api/members/${userId}/groups`, { groupIds }, { schema: myGroupsSchema }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.members.all })
    },
  })
}

// ---- Visibility ---------------------------------------------------------------------------------

export interface SetVisibilityInput extends SetVisibilityRequest {
  id: string
}

export function useSetDocumentVisibility() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: SetVisibilityInput) =>
      api.put(`/api/ai/documents/${id}/visibility`, body, { schema: documentSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.documents.all }),
  })
}

export function useSetPageVisibility() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: SetVisibilityInput) =>
      api.put(`/api/analytics/pages/${id}/visibility`, body, { schema: analyticsPageSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all }),
  })
}

export type { ResourceVisibility }
