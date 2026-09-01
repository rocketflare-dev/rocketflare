/**
 * `tenants` — the organisation every domain row hangs off (D1, D25). The one table whose tenant
 * key is its own primary key, so its policy is `tenantIsolation('tenants', sql\`id\`)`.
 * `many()` relations live in `relations.ts` — importing dependents here would be circular
 * (`tenantRef(tenants)` is evaluated eagerly at module load).
 *
 * `status` (Node reference app) lets a global admin suspend an org — the auth middleware then
 * answers 403 `tenant_suspended`. `seedDataCreated` + `lastAccessedAt` (Workers reference app)
 * are the demo-tenant lifecycle: a cron may purge demo data from idle tenants.
 */
import { sql } from 'drizzle-orm'
import { boolean, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { tenantIsolation } from './rls'

export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended'])

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** URL-safe identifier (`slugSchema` in src/shared/tenants.ts). */
    slug: text('slug').notNull().unique(),
    status: tenantStatusEnum('status').notNull().default('active'),
    /** True once demo/seed rows were generated for this tenant (`pnpm seed`, onboarding). */
    seedDataCreated: boolean('seed_data_created').notNull().default(false),
    /** Touched (fire-and-forget) by the auth middleware; drives idle-tenant housekeeping. */
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    ...timestamps(),
  },
  () => [tenantIsolation('tenants', sql`id`)]
)

export type Tenant = typeof tenants.$inferSelect
export type NewTenant = typeof tenants.$inferInsert
