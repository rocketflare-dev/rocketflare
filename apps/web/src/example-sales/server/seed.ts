/** `pnpm seed` turns the flag on; `pnpm seed --demo` adds three leads, two owned by the seeded owner. */
import { EXAMPLE_SALES_FLAG } from '@rocketflare/shared/example-sales/index'
import type { SeedCtx } from '@/plugins/api'
import { exampleLeads } from '../db/schema'

export async function seed(ctx: SeedCtx): Promise<void> {
  await ctx.setFeature?.(EXAMPLE_SALES_FLAG)
}

export async function seedDemo(ctx: SeedCtx): Promise<void> {
  await ctx.db
    .insert(exampleLeads)
    .values([
      {
        id: ctx.demoId('lead:northwind'),
        tenantId: ctx.tenantId,
        name: 'Dana Ruiz',
        company: 'Northwind Freight',
        notes: 'Asked for a quote on cold-chain storage for the spring season.',
        ownerUserId: ctx.ownerId,
      },
      {
        id: ctx.demoId('lead:harbour'),
        tenantId: ctx.tenantId,
        name: 'Sam Okafor',
        company: 'Harbour Logistics',
        notes: '',
        ownerUserId: ctx.ownerId,
      },
      {
        id: ctx.demoId('lead:walk-in'),
        tenantId: ctx.tenantId,
        name: 'Walk-in enquiry',
        company: '',
        notes: '',
      },
    ])
    .onConflictDoNothing()
  ctx.log('3 leads (two owned by the seeded owner), example-sales flag on')
}
