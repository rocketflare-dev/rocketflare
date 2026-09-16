/**
 * `example_notes` (D31) — the reference plugin's one table, and the proof that a plugin can own
 * tenant data on the same terms as the kit.
 *
 * Everything here is the kit's schema convention, unchanged, because that is the point: `tenantRef()`
 * first so the FK and the cascade are spelled once, `timestamps()` for `timestamptz` columns, every
 * index led by `tenant_id`, and `tenantIsolation()` so the RLS policy exists whether or not
 * `TENANT_SCOPE_MODE` is ever flipped to `enforce`. `rls-coverage.test.ts` reads the catalog, so a
 * plugin table with no policy fails the host's suite exactly as a kit one would.
 *
 * The only plugin-specific rule is the NAME: `<id>_*` with the hyphens of the id dropped, so two
 * plugins cannot claim one table and `db/schema/index.ts` never has to arbitrate. A collision
 * would surface as TS2308 on the `export *` line rather than as DDL for a shadowed table.
 *
 * `ownerUserId` is nullable and `onDelete: 'set null'`: a note outlives the person who wrote it, and
 * the route's own-row check reads `null` as "nobody owns this", which only admins may then edit.
 * `relations()` names this plugin's OWN tables only — see `apps/web/src/plugins/schema.ts` for why
 * a second `relations()` over a core table silently breaks `with:` app-wide.
 */
import { relations } from 'drizzle-orm'
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from '../../../../db/schema/_helpers'
import { tenantIsolation } from '../../../../db/schema/rls'
import { tenants } from '../../../../db/schema/tenants'
import { users } from '../../../../db/schema/users'

export const exampleNotes = pgTable(
  'example_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** Who wrote it; null once that person is deleted, which is an admin-only row from then on. */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    ...timestamps(),
  },
  table => [
    // The list query is "this tenant's notes, newest first"; the owner index serves the own-row
    // writes. Both start with tenant_id, which is what keeps them selective under the predicate
    // every query carries.
    index('example_notes_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('example_notes_tenant_owner_idx').on(table.tenantId, table.ownerUserId),
    tenantIsolation('example_notes'),
  ]
)

export const exampleNotesRelations = relations(exampleNotes, ({ one }) => ({
  tenant: one(tenants, { fields: [exampleNotes.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [exampleNotes.ownerUserId], references: [users.id] }),
}))

export type ExampleNoteRow = typeof exampleNotes.$inferSelect
export type NewExampleNoteRow = typeof exampleNotes.$inferInsert
