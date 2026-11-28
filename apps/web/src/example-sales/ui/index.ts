/** `example-sales`' UI half: one lazy page and its nav item, behind the domain's flag. */
import { BriefcaseIcon } from '@heroicons/react/24/outline'
import {
  EXAMPLE_SALES_FLAG,
  EXAMPLE_SALES_ID,
  exampleSalesShared,
} from '@rocketflare/shared/example-sales/index'
import { lazy } from 'react'
import { defineDomainUi, type NavGuard } from '@/plugins/api/ui-wiring'
import { exampleSalesQueryKeys } from './query-keys'

const LeadsPage = lazy(() => import('./pages/LeadsPage'))

export const EXAMPLE_SALES_GUARD: NavGuard = { feature: EXAMPLE_SALES_FLAG }

export const exampleSalesUi = defineDomainUi({
  id: EXAMPLE_SALES_ID,
  shared: exampleSalesShared,
  routes: [{ path: '/example-sales', Component: LeadsPage, guard: EXAMPLE_SALES_GUARD }],
  nav: [
    {
      items: [
        { to: '/example-sales', label: 'Leads', icon: BriefcaseIcon, guard: EXAMPLE_SALES_GUARD },
      ],
    },
  ],
  queryKeys: exampleSalesQueryKeys,
})
