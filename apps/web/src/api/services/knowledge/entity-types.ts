/**
 * The APP's own knowledge entity types (D43) — the domain rows extraction may attach facts to.
 * This file is yours, the way your routes are: the kit core registers no domain types, so it
 * ships empty, and every installed plugin's `ServerPlugin.knowledgeEntityTypes` is added to it by
 * `knowledgeEntityTypes()` (`./registry.ts`).
 *
 * An app type is a bare snake_case name (`customer`, `purchase_order`) — no dot; a dot means a
 * plugin owns the type. Fact keys are snake_case, and each value schema must render as JSON
 * schema (a date is `z.iso.date()`, not `z.date()`). `.describe()` steers extraction.
 *
 * Registering one (import the table FILE directly, never `db/schema/index.ts`):
 *
 *     import { z } from 'zod'
 *     import { customers } from '../../../db/schema/customers'
 *
 *     export const APP_ENTITY_TYPES: readonly EntityTypeRegistration[] = [
 *       {
 *         type: 'customer',
 *         label: 'Customer',
 *         table: customers,
 *         labelColumn: customers.name,          // what the default resolver matches
 *         aliasColumns: [customers.tradingName], // text or text[] columns, optional
 *         facts: z.object({
 *           contact_name: z.string().describe('The main contact at the customer'),
 *           renewal_date: z.iso.date().describe('When the contract renews'),
 *         }),
 *       },
 *       // A type with NO table lives only as staging entities until somebody promotes one:
 *       { type: 'supplier', label: 'Supplier', facts: z.object({ lead_time_days: z.number() }) },
 *     ]
 *
 * Add `resolve: (name, scope) => …` when label similarity is the wrong match (an order NUMBER);
 * it must filter by `scope.access.tenantId`.
 */
import type { EntityTypeRegistration } from './types'

export const APP_ENTITY_TYPES: readonly EntityTypeRegistration[] = []
