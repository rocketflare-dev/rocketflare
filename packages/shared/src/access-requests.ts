/**
 * Gated sign-up contracts (D9, D13): a request lodged by an uninvited person and the global
 * admin's decision. Approving is the ONLY path that creates an organisation outside `create-org`;
 * the `new_org` branch is refused with 404 `tenancy_mode_single` under `TENANCY_MODE=single` (D25).
 */
import { z } from 'zod'
import { paginationQuerySchema } from './pagination'
import { slugSchema, tenantNameSchema, tenantRoleSchema } from './tenants'

export const accessRequestStatusSchema = z.enum(['pending', 'approved', 'rejected'])
export type AccessRequestStatus = z.infer<typeof accessRequestStatusSchema>

export const accessRequestSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  userId: z.string().uuid().nullable(),
  requestedTenantId: z.string().uuid().nullable(),
  /** Resolved name of `requestedTenantId`, for the admin queue. */
  requestedTenantName: z.string().nullable().optional(),
  message: z.string().nullable(),
  status: accessRequestStatusSchema,
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AccessRequest = z.infer<typeof accessRequestSchema>

export const createAccessRequestSchema = z.object({
  /** Overridden by the session's email when the requester is signed in. */
  email: z.string().trim().toLowerCase().email(),
  message: z.string().trim().max(1000).optional(),
  requestedTenantId: z.string().uuid().optional(),
})
export type CreateAccessRequest = z.infer<typeof createAccessRequestSchema>

export const accessRequestListQuerySchema = paginationQuerySchema.extend({
  status: accessRequestStatusSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
})
export type AccessRequestListQuery = z.infer<typeof accessRequestListQuerySchema>

/** Join an existing org, or mint a new one with the requester as owner. */
export const approveAccessRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('join'),
    tenantId: z.string().uuid(),
    role: tenantRoleSchema.default('member'),
  }),
  z.object({
    mode: z.literal('new_org'),
    name: tenantNameSchema,
    slug: slugSchema.optional(),
  }),
])
export type ApproveAccessRequest = z.infer<typeof approveAccessRequestSchema>

export const decideAccessRequestSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), approve: approveAccessRequestSchema }),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().max(1000).optional() }),
])
export type DecideAccessRequest = z.infer<typeof decideAccessRequestSchema>

/** What `/auth/session` surfaces for a user with no tenant (drives the /pending page). */
export const sessionAccessRequestSchema = z.object({
  status: accessRequestStatusSchema,
})
export type SessionAccessRequest = z.infer<typeof sessionAccessRequestSchema>
