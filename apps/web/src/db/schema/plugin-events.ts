/**
 * `plugin_events` — one row per event a plugin emitted (D42): `sites.form.submitted`, with its
 * validated payload, for one tenant. The row is the DURABLE half of `ctx.emit`: it is written
 * before any delivery is queued, each delivery job carries only its id, and a handler re-reads the
 * payload from here under the tenant predicate — so the payload never travels through a queue
 * message, a log line or a Workflow param.
 *
 * - **Deduplicated** on `(tenant_id, name, idempotency_key)` while a key is given: a second emit
 *   with the same key answers the first row. NULL keys are never equal, so a keyless emit always
 *   records.
 * - **`dispatched_at`** is set once every delivery is on the queue. A row without it is an emit
 *   that recorded and then failed to enqueue; the same idempotency key re-queues it.
 * - **Short-lived**: a payload may hold personal data (a form's fields), so the nightly cron
 *   deletes rows older than `EVENTS_RETENTION_DAYS` (7) across every tenant in one statement, and
 *   the tenant FK cascades. A delivery retried after the prune finds nothing and is acked.
 * - `source` is the declaring plugin's id, for an operator reading the table.
 */
import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const pluginEvents = pgTable(
  'plugin_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** `<plugin id>.<name>`, as declared in the plugin's `SharedPlugin.events`. */
    name: text('name').notNull(),
    /** The plugin that declares the event. */
    source: text('source').notNull(),
    /** Validated against the declaration at emit; re-validated on delivery. Never logged. */
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('plugin_events_tenant_created_idx').on(table.tenantId, table.createdAt),
    uniqueIndex('plugin_events_tenant_name_key_idx')
      .on(table.tenantId, table.name, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    tenantIsolation('plugin_events'),
  ]
)

export type PluginEventRow = typeof pluginEvents.$inferSelect
