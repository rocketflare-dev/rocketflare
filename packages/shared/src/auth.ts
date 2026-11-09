/**
 * Auth contracts: the public user, `/auth/session`'s response (the UI's whole
 * bootstrap — who am I, which org, what may I do, which features are on, which modes the server
 * runs), `/auth/methods`, and the login/tenant-switch request bodies.
 */
import { z } from 'zod'
import { sessionAccessRequestSchema } from './access-requests'
import { isSameOriginPath } from './paths'
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

/** `oidc` is the one generic OpenID Connect issuer a deployment may configure (`OIDC_ISSUER`). */
export const oauthProviderNameSchema = z.enum(['google', 'microsoft', 'oidc'])
export type OAuthProviderName = z.infer<typeof oauthProviderNameSchema>

/**
 * A sign-in method an installed plugin contributes (`ServerPlugin.loginMethods`) — an SSO
 * connection the kit knows nothing about. The login page renders a button that NAVIGATES (full
 * page) to `startPath`, which is always under `/api/hooks/<plugin id>/`: the plugin's own public
 * route starts its flow and finishes it with `identity.signIn`. `askEmail` puts an email field in
 * front of the button and sends it as `?email=` (home-realm discovery: the plugin picks the
 * connection from the domain).
 */
export const pluginLoginMethodSchema = z.object({
  /** `<plugin id>:<method id>` on the wire, so two plugins' methods never share a key. */
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  startPath: z.string().regex(/^\/api\/hooks\/[a-z][a-z0-9-]*\/[^?#]*$/),
  askEmail: z.boolean().optional(),
  /**
   * The login page's copy for the `?error=<code>` codes this method's routes redirect with. Every
   * code is `<plugin id>.<name>` (the host drops a method declaring any other), so a plugin can
   * never restyle a kit code; the page shows this server-sent text, never text from the URL.
   */
  errors: z.record(z.string(), z.string().min(1).max(300)).optional(),
})
export type PluginLoginMethod = z.infer<typeof pluginLoginMethodSchema>

/** Which login methods the server has configured — drives the login page. */
export const authMethodsSchema = z.object({
  magicLink: z.boolean(),
  providers: z.array(oauthProviderNameSchema),
  /** `APP_ENV !== 'production'` only; the route 404s otherwise. */
  devLogin: z.boolean(),
  /** Present only when an OIDC issuer is configured: the button text (`OIDC_LABEL`). */
  oidc: z.object({ label: z.string() }).optional(),
  /**
   * `AUTH_OIDC_ONLY`: the login page shows only the SSO button (a click, never an automatic
   * redirect) and HIDES every other method.
   * Hides, not disables — the magic-link endpoint stays live for invitations and guests.
   */
  oidcOnly: z.boolean().optional(),
  /**
   * Present only when an installed plugin contributes a method. Shown even under `oidcOnly`: a
   * plugin's method is single sign-on too, and `AUTH_OIDC_ONLY` hides the kit's NON-SSO methods.
   */
  pluginMethods: z.array(pluginLoginMethodSchema).optional(),
})
export type AuthMethods = z.infer<typeof authMethodsSchema>

/**
 * `POST /auth/logout` answers 204 — or, when the OIDC issuer advertises an `end_session_endpoint`,
 * 200 with the URL the browser must visit to end the issuer's session too (RP-initiated logout).
 */
export const logoutResponseSchema = z.object({ endSessionUrl: z.string().url() })
export type LogoutResponse = z.infer<typeof logoutResponseSchema>

export { isSameOriginPath }

/** A same-origin relative path (`/settings/members`), never a full URL — open-redirect guard. */
export const redirectToSchema = z
  .string()
  .max(2048)
  .refine(isSameOriginPath, 'Must be a relative path')

/**
 * `POST /auth/cli/confirm` — the signed-in person's "yes" on `/cli/confirm`. `redirectUri` is
 * re-validated on the server; `hostname` names the key; `state` is the value the CLI generated,
 * handed back in the loopback callback untouched so the CLI can match it to its own login.
 */
export const cliConfirmRequestSchema = z.object({
  redirectUri: z.string().max(2048),
  hostname: z.string().max(253).optional(),
  state: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/)
    .optional(),
})
export type CliConfirmRequest = z.infer<typeof cliConfirmRequestSchema>

export const cliConfirmResponseSchema = z.object({
  /** The loopback URL to send the browser to; it carries the new key in its query. */
  redirectTo: z.string(),
})
export type CliConfirmResponse = z.infer<typeof cliConfirmResponseSchema>

export const magicLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  redirectTo: redirectToSchema.optional(),
})
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>

export const selectTenantRequestSchema = z.object({
  tenantId: z.string().uuid(),
})
export type SelectTenantRequest = z.infer<typeof selectTenantRequestSchema>

/** Dev-only login without email; the server refuses it in production. */
export const devLoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100).optional(),
  redirectTo: redirectToSchema.optional(),
})
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>
