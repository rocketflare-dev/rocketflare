/**
 * The role → ability matrix (D10, 02 §10b) as CASL rules. Pure: no logger, no DB, no Hono — the
 * same function runs in the auth middleware (server) and, via `packRules`/`unpackRules`, in the
 * UI's `AbilityProvider`. Owner-ONLY actions (delete tenant, transfer ownership) are NOT here:
 * routes check `role === 'owner'` explicitly (`isOwnerLevel`), because `manage Tenant` is also
 * granted to `support` and to global admins.
 *
 * Skeleton from the Node reference app; typed `AppAbility`, the `access` feature hook with injected
 * `features` from the Workers reference app (its subscription-tier switch is deliberately not ported).
 */
import { AbilityBuilder, createMongoAbility, type RawRuleOf } from '@casl/ability'
import { packRules as caslPackRules, unpackRules as caslUnpackRules } from '@casl/ability/extra'
import {
  type AppAbility,
  type EffectiveRole,
  featureSubject,
  type PackedRule,
  type PackedRules,
  type Role,
  type Subjects,
} from '@gmgo/shared/permissions'

type Can = AbilityBuilder<AppAbility>['can']
type Cannot = AbilityBuilder<AppAbility>['cannot']

/** What the matrix may vary on. `features` are resolved by the app (tenant flag, KV, env). */
export interface AbilityContext {
  role: Role | null
  isGlobalAdmin: boolean
  features: readonly string[]
}

export type RoleGrant = (can: Can, cannot: Cannot, ctx: AbilityContext) => void

/** Subjects an admin-level role manages; owner adds `Tenant` on top. */
export const ADMIN_MANAGED: readonly Subjects[] = [
  'TenantMember',
  'Invitation',
  'ApiKey',
  'ActivityEvent',
  'File',
]

/** What every member may at least read. */
export const MEMBER_READABLE: readonly Subjects[] = ['Tenant', ...ADMIN_MANAGED]

const grantAdmin: RoleGrant = can => {
  can('read', 'Tenant')
  can('manage', [...ADMIN_MANAGED])
  can('manage', 'Notification')
}

/**
 * EXACTLY 02 §10b. `AccessRequest` and `User` are platform subjects: only `manage all` reaches them.
 *
 * | Subject        | globalAdmin | owner  | admin  | support | member |
 * |----------------|-------------|--------|--------|---------|--------|
 * | all            | manage      | –      | –      | –       | –      |
 * | Tenant         | manage      | manage | read   | manage  | read   |
 * | TenantMember   | manage      | manage | manage | manage  | read   |
 * | Invitation     | manage      | manage | manage | manage  | read   |
 * | ApiKey         | manage      | manage | manage | manage  | read   |
 * | ActivityEvent  | manage      | manage | manage | manage  | read   |
 * | Notification   | manage      | manage | manage | manage  | manage |
 * | File           | manage      | manage | manage | manage  | create+read (own; delete is the route's owner check) |
 * | Feature:<f>    | access all  | by ctx | by ctx | access all | by ctx |
 */
export const rolePermissions: Record<EffectiveRole, RoleGrant> = {
  globalAdmin: can => {
    can('manage', 'all')
  },
  owner: (can, cannot, ctx) => {
    grantAdmin(can, cannot, ctx)
    can('manage', 'Tenant')
  },
  admin: grantAdmin,
  /** A global admin visiting from /admin: admin grants + `manage Tenant` + every feature. */
  support: (can, cannot, ctx) => {
    grantAdmin(can, cannot, ctx)
    can('manage', 'Tenant')
    can('access', 'all')
  },
  member: can => {
    can('read', [...MEMBER_READABLE])
    can('manage', 'Notification')
    // D23: anyone may upload; deleting someone else's file needs `delete File` (admin+). The
    // "own file" delete is an explicit `ownerUserId === user.id` check in routes/files.ts.
    can('create', 'File')
  },
}

/** `features: ['analytics']` → `can('access', 'Feature:analytics')`. Additive only. */
export function applyFeatureFlags(can: Can, features: readonly string[]): void {
  for (const feature of features) can('access', featureSubject(feature))
}

/** `isGlobalAdmin` wins; otherwise the membership role; null → an ability that permits nothing. */
export function getEffectiveRole(session: {
  isGlobalAdmin?: boolean | null
  tenantUser?: { role: Role } | null
  role?: Role | null
}): EffectiveRole | null {
  if (session.isGlobalAdmin) return 'globalAdmin'
  return session.tenantUser?.role ?? session.role ?? null
}

export function buildAbility(ctx: AbilityContext): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility)
  const effective = getEffectiveRole(ctx)
  if (effective) rolePermissions[effective](can, cannot, ctx)
  applyFeatureFlags(can, ctx.features)
  return build()
}

/** An ability with no rules — what an unauthenticated request carries. */
export function emptyAbility(): AppAbility {
  return createMongoAbility<AppAbility>([])
}

/** Wire format for `/auth/session.permissions` (D13). */
export function packRules(ability: AppAbility): PackedRule[] {
  return caslPackRules(ability.rules as RawRuleOf<AppAbility>[])
}

/** Client side: `createMongoAbility(unpackRules(session.permissions))`. */
export function unpackRules(rules: PackedRules): RawRuleOf<AppAbility>[] {
  return caslUnpackRules<RawRuleOf<AppAbility>>(rules as PackedRule[])
}

/** Rebuild an ability from packed rules (UI `AbilityProvider`, tests). */
export function abilityFromPackedRules(rules: PackedRules): AppAbility {
  return createMongoAbility<AppAbility>(unpackRules(rules))
}
