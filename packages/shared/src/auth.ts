/**
 * Auth contracts (D9, D11, D13, D25): the public user, `/auth/session`'s response (the UI's whole
 * bootstrap — who am I, which org, what may I do, which features are on, which modes the server
 * runs), `/auth/methods`, and the login/tenant-switch request bodies.
 */
import { z } from 'zod'
import { sessionAccessRequestSchema } from './access-requests'
import { packedRulesSchema } from './permissions'
import { membershipRoleSchema } from './tenants'

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  isGlobalAdmin: z.boolean(),
  emailVerifiedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type User = z.infer<typeof userSchema>

/** A tenant as seen from one user's membership — what the org switcher lists. */
export const tenantSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: membershipRoleSchema,
})
export type TenantSummary = z.infer<typeof tenantSummarySchema>

export const tenancyModeSchema = z.enum(['multi', 'single'])
export type TenancyMode = z.infer<typeof tenancyModeSchema>

export const signupModeSchema = z.enum(['open', 'invite_only', 'approval'])
export type SignupMode = z.infer<typeof signupModeSchema>

export const sessionResponseSchema = z.object({
  user: userSchema,
  /** The active tenant, or null when the user belongs to none (see `accessRequest`). */
  tenant: tenantSummarySchema.nullable(),
  tenants: z.array(tenantSummarySchema),
  /** CASL rules for the active tenant, packed (`packRules`); `unpackRules` on the client. */
  permissions: packedRulesSchema,
  /** Feature flags on for this tenant → `can('access', 'Feature:<name>')`. */
  features: z.array(z.string()),
  accessRequest: sessionAccessRequestSchema.nullable(),
  tenancyMode: tenancyModeSchema,
  signupMode: signupModeSchema,
  /** `RELEASE_VERSION` — lets the UI prompt for a reload after a deploy. */
  version: z.string(),
})
export type SessionResponse = z.infer<typeof sessionResponseSchema>

export const oauthProviderNameSchema = z.enum(['google', 'microsoft'])
export type OAuthProviderName = z.infer<typeof oauthProviderNameSchema>

/** Which login methods the server has configured — drives the login page. */
export const authMethodsSchema = z.object({
  magicLink: z.boolean(),
  providers: z.array(oauthProviderNameSchema),
  /** `APP_ENV !== 'production'` only; the route 404s otherwise. */
  devLogin: z.boolean(),
})
export type AuthMethods = z.infer<typeof authMethodsSchema>

/** A same-origin relative path (`/settings/members`), never a full URL — open-redirect guard. */
export const redirectToSchema = z
  .string()
  .max(2048)
  .regex(/^\/(?![/\\])/, 'Must be a relative path')

export const magicLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  redirectTo: redirectToSchema.optional(),
})
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>

export const selectTenantRequestSchema = z.object({
  tenantId: z.string().uuid(),
})
export type SelectTenantRequest = z.infer<typeof selectTenantRequestSchema>

/** Dev-only login without email; the server refuses it in production (D11). */
export const devLoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100).optional(),
  redirectTo: redirectToSchema.optional(),
})
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>
