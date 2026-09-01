/**
 * Global-admin (`/api/admin/*`) contracts (D9, D10, D13, D25). Cross-tenant by design — the only
 * surface that is. List items are deliberately flatter than the tenant-scoped schemas.
 */
import { z } from 'zod'
import { paginationQuerySchema } from './pagination'
import { membershipRoleSchema, tenantStatusSchema } from './tenants'

// ---- Tenants ------------------------------------------------------------------------------

export const adminTenantListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: tenantStatusSchema,
  /** Real members — `NON_MEMBER_ROLES` excluded. */
  memberCount: z.number().int(),
  seedDataCreated: z.boolean(),
  lastAccessedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AdminTenantListItem = z.infer<typeof adminTenantListItemSchema>

export const adminTenantListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  status: tenantStatusSchema.optional(),
})
export type AdminTenantListQuery = z.infer<typeof adminTenantListQuerySchema>

export const adminTenantMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: membershipRoleSchema,
  isGlobalAdmin: z.boolean(),
  blockedAt: z.coerce.date().nullable(),
  joinedAt: z.coerce.date(),
})

export const adminTenantDetailSchema = adminTenantListItemSchema.extend({
  members: z.array(adminTenantMemberSchema),
  /** Whether the calling admin currently holds a `support` membership here. */
  supportAccess: z.boolean(),
})
export type AdminTenantDetail = z.infer<typeof adminTenantDetailSchema>

export const suspendTenantRequestSchema = z.object({
  suspended: z.boolean(),
})
export type SuspendTenantRequest = z.infer<typeof suspendTenantRequestSchema>

// ---- Users --------------------------------------------------------------------------------

export const adminUserListItemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  isGlobalAdmin: z.boolean(),
  emailVerifiedAt: z.coerce.date().nullable(),
  lastLoginAt: z.coerce.date().nullable(),
  blockedAt: z.coerce.date().nullable(),
  tenantCount: z.number().int(),
  createdAt: z.coerce.date(),
})
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>

export const adminUserListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  tenantId: z.string().uuid().optional(),
  filter: z.enum(['global_admin', 'blocked', 'no_tenant']).optional(),
})
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>

export const adminUserDetailSchema = adminUserListItemSchema.extend({
  memberships: z.array(
    z.object({
      tenantId: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      role: membershipRoleSchema,
      joinedAt: z.coerce.date(),
    })
  ),
  providers: z.array(z.object({ provider: z.string(), createdAt: z.coerce.date() })),
})
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>

export const setGlobalAdminRequestSchema = z.object({
  isGlobalAdmin: z.boolean(),
})
export type SetGlobalAdminRequest = z.infer<typeof setGlobalAdminRequestSchema>

export const blockUserRequestSchema = z.object({
  blocked: z.boolean(),
})
export type BlockUserRequest = z.infer<typeof blockUserRequestSchema>
