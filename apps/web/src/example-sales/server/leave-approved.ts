/**
 * `example-hr.leave.approved` → hand the person's open leads back to the pool. An EVENT is how one
 * domain reacts to "something happened" in another: HR emits it and never learns who listens, so
 * the coupling is a name and a payload schema, not an import. Idempotent on the event — releasing
 * already-released leads changes nothing.
 */
import { EXAMPLE_LEAVE_APPROVED_EVENT } from '@rocketflare/shared/example-hr/index'
import { EXAMPLE_SALES_LEADS_ENTITY } from '@rocketflare/shared/example-sales/index'
import type { EventHandler } from '@/plugins/api'
import { eventCtx } from '@/plugins/api'
import { releaseLeadsOf } from './leads'

export const releaseLeadsOnLeave: EventHandler<typeof EXAMPLE_LEAVE_APPROVED_EVENT> = {
  event: EXAMPLE_LEAVE_APPROVED_EVENT,
  name: 'release-leads',
  handle: async (event, raw) => {
    const ctx = eventCtx(raw)
    const released = await releaseLeadsOf(ctx.db, ctx.tenantId, event.payload.userId)
    if (released > 0) await ctx.nudge(EXAMPLE_SALES_LEADS_ENTITY)
  },
}
