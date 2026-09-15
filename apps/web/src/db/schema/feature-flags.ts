/**
 * Feature flags (D30) — the stored half. The KEYS live in code (`FEATURE_FLAGS` in
 * `@rocketflare/shared/features`); these two tables hold only what a global admin changes, so
 * adding or retiring a flag is a code edit and never a migration.
 *
 * `feature_flags` is PLATFORM-level and deliberately has no `tenant_id`: it is the rollout state of
 * one flag across every organisation, edited only behind `globalAdminMiddleware`. That is why it
 * appears in `RLS_EXCLUDED_TABLES` rather than carrying a policy.
 *
 * Three decisions worth stating, because each is somewhere a reader will reach for the wrong thing:
 *
 * - **`key` is the primary key, with no surrogate `id`.** The key is the identity in every consumer
 *   — `requireFeature('x')`, the hash input, the override FK, the registry lookup. A uuid beside it
 *   would be a second identity nobody uses. (`group_members` and every fact table set the same
 *   precedent.) The key is therefore immutable: renaming a flag is delete-then-create, because the
 *   string is compiled into the app.
 * - **`state` is kept even though `off` and `rollout` at 0% have the same outcome.** The column is
 *   the decision and the number is only its parameter — collapsing them would mean pausing a
 *   rollout by dialling it to 0 destroys the percentage you had reached.
 * - **`tenant_feature_overrides` has NO composite FK to `tenant_users`.** `group_members` carries
 *   one so losing a membership loses the grants; copying it here would reject every write, because
 *   the person setting an override is a global admin who is almost never a member of the tenant
 *   they are overriding. `set_by_user_id` is `ON DELETE SET NULL` for the same reason a fact table
 *   has no FK to `users`: administration must not fail because somebody left.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `FEATURE_FLAG_STATES` in `@rocketflare/shared/features`; `pgEnum` values are append-only. */
export const featureFlagStateEnum = pgEnum('feature_flag_state', ['off', 'on', 'rollout'])

/** Mirrors `FEATURE_ROLLOUT_UNITS`. What a percentage counts: whole organisations, or people. */
export const featureRolloutUnitEnum = pgEnum('feature_rollout_unit', ['tenant', 'user'])

export const featureFlags = pgTable(
  'feature_flags',
  {
    /** A `FeatureName` from the shared registry. Not validated by the DB — the code registry is. */
    key: text('key').primaryKey(),
    state: featureFlagStateEnum('state').notNull().default('off'),
    rolloutPercent: integer('rollout_percent').notNull().default(0),
    rolloutUnit: featureRolloutUnitEnum('rollout_unit').notNull().default('tenant'),
    /** Who last moved it. The whole audit trail, alongside the request log — see CONCEPTS §D30. */
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    check('feature_flags_rollout_percent_range', sql`${table.rolloutPercent} between 0 and 100`),
  ]
)

export const tenantFeatureOverrides = pgTable(
  'tenant_feature_overrides',
  {
    tenantId: tenantRef(tenants),
    flagKey: text('flag_key')
      .notNull()
      .references(() => featureFlags.key, { onDelete: 'cascade', onUpdate: 'cascade' }),
    /**
     * The decision itself, both directions. An override exists to say "this customer gets it early"
     * OR "this customer must never get it" — deleting the row means "follow the platform state",
     * which is why the admin UI offers three choices rather than a checkbox.
     */
    enabled: boolean('enabled').notNull(),
    setByUserId: uuid('set_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  table => [
    primaryKey({ columns: [table.tenantId, table.flagKey] }),
    /**
     * Deliberately NOT led by `tenant_id`, unlike every other index in this schema. It serves one
     * query — "every override on this flag" in `/admin` — which is cross-tenant by design and
     * reachable only behind `globalAdminMiddleware`. Do not "fix" it.
     */
    index('tenant_feature_overrides_flag_idx').on(table.flagKey),
    tenantIsolation('tenant_feature_overrides'),
  ]
)

export const featureFlagsRelations = relations(featureFlags, ({ many }) => ({
  overrides: many(tenantFeatureOverrides),
}))

export const tenantFeatureOverridesRelations = relations(tenantFeatureOverrides, ({ one }) => ({
  flag: one(featureFlags, {
    fields: [tenantFeatureOverrides.flagKey],
    references: [featureFlags.key],
  }),
  tenant: one(tenants, {
    fields: [tenantFeatureOverrides.tenantId],
    references: [tenants.id],
  }),
}))

export type FeatureFlagRow = typeof featureFlags.$inferSelect
export type NewFeatureFlagRow = typeof featureFlags.$inferInsert
export type TenantFeatureOverrideRow = typeof tenantFeatureOverrides.$inferSelect
export type NewTenantFeatureOverrideRow = typeof tenantFeatureOverrides.$inferInsert
