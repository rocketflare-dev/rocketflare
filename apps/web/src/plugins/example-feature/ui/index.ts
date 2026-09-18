/**
 * `example-feature` — the reference plugin's UI entry (D31).
 *
 * **This file ships in the MAIN bundle**, because `App.tsx` and `SideNav` import the barrel that
 * imports it, for every reader — including the ones who never open the plugin. So it wires things
 * up and nothing else: the page arrives as `lazy(() => import(...))`, and the only host module it
 * may import is `@/plugins/api/ui-wiring` — the WIRING half of the UI kit, which is types, one
 * helper and one hook. The COMPONENTS half (`@/plugins/api/ui`) is deliberately unreachable from
 * here; that is for a lazy PAGE, which ships in its own chunk.
 * `tests/config/plugins.test.ts` reads this file's SOURCE and enforces both rules — a statically
 * imported page is the mistake it exists to catch.
 *
 * The route's guard and the nav item's guard are the SAME object, so a link can never point at a
 * page its reader cannot open. It is `{ feature }`, never `{ action: 'access', subject:
 * 'Feature:example-feature' }`: a global admin's `manage all` satisfies the CASL form, which would
 * show them a nav item whose routes the server 404s.
 */
import { SparklesIcon } from '@heroicons/react/24/outline'
import {
  EXAMPLE_FEATURE_FLAG,
  exampleFeatureShared,
} from '@rocketflare/shared/plugins/example-feature/index'
import { lazy } from 'react'
import type { NavGuard, UiPlugin } from '@/plugins/api/ui-wiring'
import { exampleFeatureQueryKeys } from './query-keys'

const ExampleFeaturePage = lazy(() => import('./pages/ExampleFeaturePage'))

/** One const for the nav item, the route and (in a real feature) any settings tab. */
export const EXAMPLE_FEATURE_GUARD: NavGuard = { feature: EXAMPLE_FEATURE_FLAG }

export const exampleFeatureUi = {
  shared: exampleFeatureShared,
  routes: [
    { path: '/example-feature', Component: ExampleFeaturePage, guard: EXAMPLE_FEATURE_GUARD },
  ],
  // No `before`, so it lands above the kit's "Organisation" group — where an app's own features go.
  nav: [
    {
      items: [
        {
          to: '/example-feature',
          label: 'Example feature',
          icon: SparklesIcon,
          guard: EXAMPLE_FEATURE_GUARD,
        },
      ],
    },
  ],
  queryKeys: exampleFeatureQueryKeys,
} satisfies UiPlugin<typeof exampleFeatureShared>
