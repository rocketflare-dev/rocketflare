/**
 * The app's own domains, UI half — ONE line per domain that has a UI, written by hand. Each entry is
 * a domain's `ui/index.ts` (`defineDomainUi`); its pages are `lazy(() => import(...))`, so this file
 * costs the main bundle the nav and route vocabulary and nothing else. App-owned, like `app.ts`.
 */
import { exampleHrUi } from './example-hr/ui'
import { exampleSalesUi } from './example-sales/ui'
import type { AnyUiDomain } from './plugins/types'

export const APP_DOMAIN_UIS = [
  exampleHrUi,
  exampleSalesUi,
] as const satisfies readonly AnyUiDomain[]
