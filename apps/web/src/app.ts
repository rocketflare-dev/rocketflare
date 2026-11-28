/**
 * The app's own domains, server half — ONE line per domain, written by hand (docs/CONCEPTS.md §20).
 *
 *     import { expenses } from './expenses'
 *     export const APP_DOMAINS = [expenses] as const satisfies readonly AnyServerDomain[]
 *
 * A domain is where this app's own concepts and logic live — `apps/web/src/<id>/` with `index.ts`
 * (`defineDomain`), `server/`, `ui/`, `db/` and at most one `public.ts`. A plugin is a capability
 * another app could install; it goes through `pnpm plugin add` and never appears here.
 *
 * App-owned: `kit:upgrade` never writes to this file (it creates it, empty, in a copy that has
 * none) and the core guard never asks about it. Its twins: `app-ui.ts` (UI halves), `app-schema.ts`
 * (tables), `packages/shared/src/app.ts` (contracts) and `apps/cli/src/app.ts` (commands).
 */
import { exampleHr } from './example-hr'
import { exampleSales } from './example-sales'
import type { AnyServerDomain } from './plugins/types'

export const APP_DOMAINS = [exampleHr, exampleSales] as const satisfies readonly AnyServerDomain[]
