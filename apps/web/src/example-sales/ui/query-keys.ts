import { EXAMPLE_SALES_LEADS_ENTITY } from '@rocketflare/shared/example-sales/index'

export const leadKeys = {
  all: [EXAMPLE_SALES_LEADS_ENTITY] as const,
  list: (page: number) => [EXAMPLE_SALES_LEADS_ENTITY, 'list', page] as const,
}

export const exampleSalesQueryKeys = { [EXAMPLE_SALES_LEADS_ENTITY]: leadKeys } as const
