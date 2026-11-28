/** `example-sales`' one table, in the `example_` namespace every example shares. */
import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tenantIsolation, tenantRef, tenants, timestamps, users } from '../../db/schema/kit'

export const exampleLeads = pgTable(
  'example_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    name: text('name').notNull(),
    company: text('company').notNull().default(''),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: ['new', 'qualified', 'disqualified'] })
      .notNull()
      .default('new'),
    score: integer('score'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  table => [
    index('example_leads_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('example_leads_tenant_owner_idx').on(table.tenantId, table.ownerUserId),
    tenantIsolation('example_leads'),
  ]
)

export type LeadRow = typeof exampleLeads.$inferSelect
