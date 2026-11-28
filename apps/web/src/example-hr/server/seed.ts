/**
 * `pnpm seed` turns the domain's flag on for the seeded organisation; `pnpm seed --demo` adds two
 * leave requests — one approved and covering today, so `example-sales` has someone on leave to
 * route around. Fixed ids and `onConflictDoNothing`, because the seed is re-run freely.
 */
import { EXAMPLE_HR_FLAG } from '@rocketflare/shared/example-hr/index'
import type { SeedCtx } from '@/plugins/api'
import { exampleLeaveRequests } from '../db/schema'

const DAY = 86_400_000
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

export async function seed(ctx: SeedCtx): Promise<void> {
  await ctx.setFeature?.(EXAMPLE_HR_FLAG)
}

export async function seedDemo(ctx: SeedCtx): Promise<void> {
  await ctx.db
    .insert(exampleLeaveRequests)
    .values([
      {
        id: ctx.demoId('leave:owner-this-week'),
        tenantId: ctx.tenantId,
        userId: ctx.ownerId,
        startsOn: isoDay(-1),
        endsOn: isoDay(3),
        reason: 'Family holiday',
        status: 'approved',
        decidedByUserId: ctx.ownerId,
        decidedAt: new Date(),
      },
      {
        id: ctx.demoId('leave:owner-next-month'),
        tenantId: ctx.tenantId,
        userId: ctx.ownerId,
        startsOn: isoDay(30),
        endsOn: isoDay(31),
        reason: 'Conference',
      },
    ])
    .onConflictDoNothing()
  ctx.log('2 leave requests (one approved, covering today), example-hr flag on')
}
