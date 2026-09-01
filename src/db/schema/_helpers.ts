/**
 * Column helpers shared by every table (D1, 03 §2): `timestamptz` everywhere, and one
 * definition of the tenant foreign key so `tenant_id` never drifts between tables.
 */
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { timestamp, uuid } from 'drizzle-orm/pg-core'

/** `created_at` / `updated_at` as `timestamptz`, both defaulting to now(). Spread into a table. */
export function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  }
}

/**
 * `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
 *
 * Takes the tenants table as an argument (rather than importing it) so this helper has no
 * dependency on a table that arrives in Phase 1 and so `tenants.ts` itself cannot import it
 * circularly. Usage: `tenantId: tenantRef(tenants)`.
 */
export function tenantRef(tenants: { id: AnyPgColumn }) {
  return uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' })
}
