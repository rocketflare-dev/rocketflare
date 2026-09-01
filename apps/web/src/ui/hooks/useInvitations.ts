/**
 * Invitations (D9, D13): the tenant's outgoing list (admin), the public accept flow keyed by
 * token, and MY pending invitations across tenants (banner).
 *
 * Contract note: `invitationSchema` carries neither the accept `token` nor the tenant's name, both
 * of which the banner needs to render "join Acme" → `/invite/<token>`. `pendingInvitationSchema`
 * accepts them as optional extras and the banner degrades (no link) when they are absent.
 */
import { sessionResponseSchema } from '@rocketflare/shared/auth'
import { paginatedResponse, paginationMetaSchema } from '@rocketflare/shared/pagination'
import {
  type BulkInviteRequest,
  type InviteMemberRequest,
  invitationDetailsSchema,
  invitationSchema,
} from '@rocketflare/shared/tenants'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const invitationsResponseSchema = paginatedResponse(invitationSchema)

export interface InvitationsFilters {
  page?: number
  pageSize?: number
}

export function invitationsQueryOptions(filters: InvitationsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.invitations.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/invitations${toSearchParams(filters)}`, { schema: invitationsResponseSchema }),
    placeholderData: keepPreviousData,
  })
}

export function useInvitations(filters: InvitationsFilters = {}) {
  return useQuery(invitationsQueryOptions(filters))
}

export function useInviteMember() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: InviteMemberRequest) =>
      api.post('/api/invitations', body, {
        schema: invitationSchema,
        showSuccessToast: true,
        successMessage: `Invitation sent to ${body.email}`,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all }),
  })
}

export function useBulkInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: BulkInviteRequest) =>
      api.post<unknown>('/api/invitations/bulk', body, {
        showSuccessToast: true,
        successMessage: `${body.emails.length} invitation${body.emails.length === 1 ? '' : 's'} sent`,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all }),
  })
}

export function useResendInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/invitations/${id}/resend`, undefined, {
        showSuccessToast: true,
        successMessage: 'Invitation resent',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all }),
  })
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/invitations/${id}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Invitation revoked',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations.all }),
  })
}

// ---- Public accept flow ---------------------------------------------------------------------

export function invitationDetailsQueryOptions(token: string) {
  return queryOptions({
    queryKey: queryKeys.invitations.details(token),
    queryFn: () =>
      api.get(`/api/invite/${encodeURIComponent(token)}`, { schema: invitationDetailsSchema }),
    enabled: token.length > 0,
    retry: false,
  })
}

/** `POST /api/invite/:token/accept` → the NEW session (member of the inviting tenant). */
export function useAcceptInvitation() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post(`/api/invite/${encodeURIComponent(token)}/accept`, undefined, {
        schema: sessionResponseSchema,
        showErrorToast: false,
      }),
  })
}

// ---- My pending invitations --------------------------------------------------------------

export const pendingInvitationSchema = invitationSchema.extend({
  token: z.string().optional(),
  tenant: z.object({ name: z.string(), slug: z.string() }).optional(),
  tenantName: z.string().optional(),
})
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>

const pendingInvitationsResponseSchema = z.object({
  items: z.array(pendingInvitationSchema),
  pagination: paginationMetaSchema.optional(),
})

export function pendingInvitationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.pendingInvitations.all,
    queryFn: () =>
      api.get('/api/invitations/pending', { schema: pendingInvitationsResponseSchema }),
  })
}

export function usePendingInvitations() {
  return useQuery(pendingInvitationsQueryOptions())
}
