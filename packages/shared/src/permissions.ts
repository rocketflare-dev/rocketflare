/**
 * Permission VOCABULARY shared by API and UI (D10, D13): actions, subjects, the typed `AppAbility`,
 * and the wire format of rules (`packRules` from `@casl/ability/extra`). The role → grant matrix
 * lives in `src/permissions/abilities.ts`; this file only names the pieces so both bundles agree.
 * Type-only dependency on @casl/ability — nothing here runs CASL.
 */
import type { MongoAbility, RawRuleOf } from '@casl/ability'
import type { PackRule } from '@casl/ability/extra'
import { z } from 'zod'
import { type MembershipRole, membershipRoleSchema } from './tenants'

export const ACTIONS = ['manage', 'create', 'read', 'update', 'delete', 'access'] as const
export type Actions = (typeof ACTIONS)[number]

/** Core subjects every kit app has. Apps extend `Subjects` (and the matrix) with their own. */
export const CORE_SUBJECTS = [
  'all',
  'Tenant',
  'TenantMember',
  'Invitation',
  'ApiKey',
  'Notification',
  'AccessRequest',
  'ActivityEvent',
  'User',
  'File',
  'AiConfig',
  'Prompt',
  'Conversation',
  'AgentRun',
  'Document',
  /** Groups (D29): group types, groups and their membership — admin+ `manage`, member `read`. */
  'Group',
  /** Analytics (D19): `Dashboard` = analytics_pages rows; `Analytics` = the cube API itself. */
  'Dashboard',
  'Analytics',
  /**
   * Feature flags (D30) — ADMINISTERING them, never using a feature. A platform subject like
   * `AccessRequest` and `User`: reachable only through `manage all`, so it is deliberately absent
   * from `ADMIN_MANAGED` and `MEMBER_READABLE`. Using a feature is `AuthContext.features`, which is
   * not a permission at all — see the warning on `FeatureSubject` below.
   */
  'FeatureFlag',
] as const
export type CoreSubject = (typeof CORE_SUBJECTS)[number]

/**
 * Feature flags are subjects too: `can('access', 'Feature:analytics')` (D10).
 *
 * **Never gate a surface that ships dark on this.** `globalAdmin` is `can('manage', 'all')` and
 * `support` is granted `access all`; in CASL those are wildcards covering `access` on every
 * `Feature:` subject, so an ability check answers "on" for platform staff no matter what the
 * deployment ships. A feature flag is CONFIGURATION, not a permission: every gate reads the
 * features ARRAY (`hasFeature(auth.features, name)` on the server, `session.features` in the
 * browser). `applyFeatureFlags` still populates these subjects for an app that genuinely wants
 * permission-style entitlements, and nothing that hides an unreleased surface may use them (D30).
 */
export type FeatureSubject = `Feature:${string}`
export const featureSubject = (feature: string): FeatureSubject => `Feature:${feature}`

/**
 * Every feature key this app knows (D30). Code, not data: a key that no code reads does nothing,
 * so inventing one at runtime buys nothing, while a registry makes `requireFeature('new-reprots')`
 * a TYPE ERROR instead of a route that 404s for ever. Adding a flag is a line here plus its
 * metadata in `features.ts` — no migration. Retiring one: delete the gate from the code, deploy,
 * then delete the line. Append-only in spirit; the metadata registry is keyed on this.
 */
export const FEATURES = ['example-feature'] as const
export type FeatureName = (typeof FEATURES)[number]

export type Subjects = CoreSubject | FeatureSubject

export type AppAbility = MongoAbility<[Actions, Subjects]>

/** The roles the ability matrix knows; `globalAdmin` is the `users.isGlobalAdmin` flag, not a role. */
export const roleSchema = membershipRoleSchema
export type Role = MembershipRole
export type EffectiveRole = Role | 'globalAdmin'

/**
 * One rule as `packRules` emits it: `[actions, subjects, conditions?, inverted?, fields?, reason?]`
 * with actions/subjects comma-joined. Validated loosely on the wire (the tail varies by rule);
 * `unpackRules` in src/permissions narrows it back to `PackedRule`.
 */
export const packedRuleSchema = z.tuple([z.string(), z.string()]).rest(z.unknown())
export const packedRulesSchema = z.array(packedRuleSchema)
export type PackedRules = z.infer<typeof packedRulesSchema>
export type PackedRule = PackRule<RawRuleOf<AppAbility>>
