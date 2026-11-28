/**
 * `example-sales` — an example APP DOMAIN's server half, the one that depends on `example-hr`
 * (docs/CONCEPTS.md §20). Between them, three couplings and the rule for each:
 *
 * - a synchronous read across domains — `server/routes.ts` calls `example-hr`'s `public.ts`, which
 *   is allowed because `dependsOn` below names `example-hr`;
 * - "something happened" — `example-hr.leave.approved`, handled by `server/leave-approved.ts`;
 * - an agent using both domains' tools in one run — `server/qualify-agent.ts`.
 *
 * Delete it on its own (nothing depends on it) or with `example-hr`: the three trees, its tests in
 * `apps/web/tests/example-sales/`, its lines in the `app*.ts` files and its surface in
 * `.rocketflare.json`, then `pnpm db:generate`.
 */
import {
  EXAMPLE_LEAD_SUBJECT,
  EXAMPLE_QUALIFY_LEAD_AGENT,
  EXAMPLE_QUALIFY_LEAD_PROMPT,
  EXAMPLE_SALES_FLAG,
  EXAMPLE_SALES_ID,
  exampleSalesShared,
} from '@rocketflare/shared/example-sales/index'
import { defineDomain, requireFeature, toolCtx } from '@/plugins/api'
import { releaseLeadsOnLeave } from './server/leave-approved'
import { qualifyLeadAgent, qualifyLeadPrompt } from './server/qualify-agent'
import { exampleSalesRouter } from './server/routes'
import { seed, seedDemo } from './server/seed'
import { exampleSalesTools } from './server/tools'

export const exampleSales = defineDomain({
  id: EXAMPLE_SALES_ID,
  shared: exampleSalesShared,
  dependsOn: ['example-hr'],
  mounts: [['/api/example-sales', exampleSalesRouter, requireFeature(EXAMPLE_SALES_FLAG)]],
  tools: ctx => exampleSalesTools(toolCtx(ctx)),
  agents: { [EXAMPLE_QUALIFY_LEAD_AGENT]: qualifyLeadAgent },
  prompts: { [EXAMPLE_QUALIFY_LEAD_PROMPT]: qualifyLeadPrompt },
  eventHandlers: [releaseLeadsOnLeave],
  grants: {
    owner: can => can('manage', EXAMPLE_LEAD_SUBJECT),
    admin: can => can('manage', EXAMPLE_LEAD_SUBJECT),
    support: can => can('read', EXAMPLE_LEAD_SUBJECT),
    member: can => {
      can('read', EXAMPLE_LEAD_SUBJECT)
      can('create', EXAMPLE_LEAD_SUBJECT)
      can('update', EXAMPLE_LEAD_SUBJECT)
    },
  },
  hooks: {
    seed: (db, ctx) => seed({ db, ...ctx }),
    seedDemo: (db, ctx) => seedDemo({ db, ...ctx }),
  },
})
