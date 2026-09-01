/**
 * Tenant, membership and invitation contracts (D9, D10, D13, D25). `tenantRoleSchema` is what an
 * invitation or role change may ASSIGN; `membershipRoleSchema` is what a membership row may HOLD
 * (adds `support`, minted only from /admin). Keep the assignable one on every input schema and the
 * validator refuses `support` for free.
 */
import { z } from 'zod'

export const tenantRoleSchema = z.enum(['owner', 'admin', 'member'])
export type TenantRole = z.infer<typeof tenantRoleSchema>

export const membershipRoleSchema = z.enum(['owner', 'admin', 'member', 'support'])
export type MembershipRole = z.infer<typeof membershipRoleSchema>

/** Roles excluded from "how many people use this org" counts (a visiting global admin). */
export const NON_MEMBER_ROLES = ['support'] as const satisfies readonly MembershipRole[]

export const tenantStatusSchema = z.enum(['active', 'suspended'])
export type TenantStatus = z.infer<typeof tenantStatusSchema>

// ---- Slugs --------------------------------------------------------------------------------

export const SLUG_MIN = 2
export const SLUG_MAX = 63
/** Lower-case letters, digits and single hyphens; no leading/trailing hyphen. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Route prefixes and words a tenant slug must never shadow. */
export const RESERVED_SLUGS = [
  'admin',
  'api',
  'auth',
  'app',
  'www',
  'new',
  'settings',
  'invite',
  'health',
  'ready',
  'ws',
] as const

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .regex(SLUG_RE, 'Use lower-case letters, digits and hyphens')
  .refine(s => !(RESERVED_SLUGS as readonly string[]).includes(s), 'This slug is reserved')

/** `"Acme, Inc."` → `"acme-inc"`; empty result → `fallback`. Same function on both ends. */
export function slugify(input: string, fallback = 'org'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return slug.length >= SLUG_MIN ? slug : fallback
}

// ---- Tenant ---------------------------------------------------------------------------------

export const tenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: tenantStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Tenant = z.infer<typeof tenantSchema>

export const tenantNameSchema = z.string().trim().min(1).max(100)

export const createTenantRequestSchema = z.object({
  name: tenantNameSchema,
  /** Derived from `name` via `slugify` when omitted. */
  slug: slugSchema.optional(),
})
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>

export const updateTenantRequestSchema = z
  .object({ name: tenantNameSchema, slug: slugSchema })
  .partial()
  .refine(v => v.name !== undefined || v.slug !== undefined, {
    message: 'Provide at least one of name or slug',
  })
export type UpdateTenantRequest = z.infer<typeof updateTenantRequestSchema>

/** `DELETE /api/tenant` — the caller retypes the slug; owner only (D10, D25). */
export const deleteTenantRequestSchema = z.object({
  confirm: z.string().trim().min(1),
})
export type DeleteTenantRequest = z.infer<typeof deleteTenantRequestSchema>

// ---- Members ------------------------------------------------------------------------------

export const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: membershipRoleSchema,
  joinedAt: z.coerce.date(),
  /** NULL = invited but never signed in. */
  lastLoginAt: z.coerce.date().nullable(),
  invitedByUserId: z.string().uuid().nullable(),
})
export type Member = z.infer<typeof memberSchema>

export const inviteMemberRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: tenantRoleSchema.default('member'),
})
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>

export const BULK_INVITE_MAX = 100

export const bulkInviteRequestSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(BULK_INVITE_MAX),
  role: tenantRoleSchema.default('member'),
})
export type BulkInviteRequest = z.infer<typeof bulkInviteRequestSchema>

export const updateMemberRoleRequestSchema = z.object({
  role: tenantRoleSchema,
})
export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>

// ---- Invitations --------------------------------------------------------------------------

/** Derived server-side from the lifecycle timestamps (`acceptedAt`, `revokedAt`, `expiresAt`). */
export const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired'])
export type InvitationStatus = z.infer<typeof invitationStatusSchema>

export const invitationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  role: tenantRoleSchema,
  status: invitationStatusSchema,
  invitedByUserId: z.string().uuid(),
  invitedByName: z.string().nullable(),
  expiresAt: z.coerce.date(),
  acceptedAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  /** Resolved tenant name — present on the cross-tenant `GET /api/invitations/pending` list. */
  tenantName: z.string().optional(),
})
export type Invitation = z.infer<typeof invitationSchema>

/** One row of `POST /api/invitations/bulk`'s answer. */
export const bulkInviteResultSchema = z.object({
  email: z.string().email(),
  status: z.enum(['invited', 'skipped', 'failed']),
  reason: z.string().optional(),
  invitationId: z.string().uuid().optional(),
})
export type BulkInviteResult = z.infer<typeof bulkInviteResultSchema>

export const bulkInviteResponseSchema = z.object({ results: z.array(bulkInviteResultSchema) })
export type BulkInviteResponse = z.infer<typeof bulkInviteResponseSchema>

/** What the PUBLIC accept page may see for a token — no ids, no other members. */
export const invitationDetailsSchema = z.object({
  email: z.string().email(),
  role: tenantRoleSchema,
  status: invitationStatusSchema,
  tenant: z.object({ name: z.string(), slug: z.string() }),
  invitedByName: z.string().nullable(),
  expiresAt: z.coerce.date(),
})
export type InvitationDetails = z.infer<typeof invitationDetailsSchema>
