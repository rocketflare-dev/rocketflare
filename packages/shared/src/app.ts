/**
 * The app's own domains, shared half — ONE line per domain, written by hand. App-owned: `kit:upgrade`
 * never writes to this file (it creates it, empty, in a copy that has none), and the core guard
 * never asks about it.
 *
 *     import { expensesShared } from './expenses/index'
 *     export const SHARED_DOMAINS = [expensesShared] as const satisfies readonly SharedDomain[]
 *
 * A domain's contracts live in `packages/shared/src/<id>/` and are imported as
 * `@rocketflare/shared/<id>/…`. Its server and UI halves are listed in `apps/web/src/app.ts` and
 * `apps/web/src/app-ui.ts`, its tables in `apps/web/src/app-schema.ts`, its CLI commands in
 * `apps/cli/src/app.ts` (docs/CONCEPTS.md §20).
 *
 * `as const` for the same reason the plugin barrel is a tuple: the composers derive the job union,
 * the agent keys and the CASL subjects from it. Iterate `sharedDomains`; an EMPTY tuple indexes to
 * `never`.
 */
import { exampleHrShared } from './example-hr/index'
import { exampleSalesShared } from './example-sales/index'
import type { SharedDomain } from './plugins/types'

export const SHARED_DOMAINS = [
  exampleHrShared,
  exampleSalesShared,
] as const satisfies readonly SharedDomain[]

/** The list widened for iteration; `SHARED_DOMAINS` is for type derivation. */
export const sharedDomains: readonly SharedDomain[] = SHARED_DOMAINS
