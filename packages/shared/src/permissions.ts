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
] as const
export type CoreSubject = (typeof CORE_SUBJECTS)[number]

/** Feature flags are subjects too: `can('access', 'Feature:analytics')` (D10). */
export type FeatureSubject = `Feature:${string}`
export const featureSubject = (feature: string): FeatureSubject => `Feature:${feature}`

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
