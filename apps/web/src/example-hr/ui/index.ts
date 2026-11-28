/**
 * `example-hr`'s UI half: one lazy page and its nav item, behind the domain's flag. Listed in
 * `apps/web/src/app-ui.ts`. Like a plugin's UI entry it ships in the main bundle, so it imports
 * only the wiring half of the UI kit and its page arrives as `lazy(...)`.
 */
import { CalendarDaysIcon } from '@heroicons/react/24/outline'
import {
  EXAMPLE_HR_FLAG,
  EXAMPLE_HR_ID,
  exampleHrShared,
} from '@rocketflare/shared/example-hr/index'
import { lazy } from 'react'
import { defineDomainUi, type NavGuard } from '@/plugins/api/ui-wiring'
import { exampleHrQueryKeys } from './query-keys'

const LeavePage = lazy(() => import('./pages/LeavePage'))

export const EXAMPLE_HR_GUARD: NavGuard = { feature: EXAMPLE_HR_FLAG }

export const exampleHrUi = defineDomainUi({
  id: EXAMPLE_HR_ID,
  shared: exampleHrShared,
  routes: [{ path: '/example-hr', Component: LeavePage, guard: EXAMPLE_HR_GUARD }],
  nav: [
    {
      items: [
        { to: '/example-hr', label: 'Leave', icon: CalendarDaysIcon, guard: EXAMPLE_HR_GUARD },
      ],
    },
  ],
  queryKeys: exampleHrQueryKeys,
})
