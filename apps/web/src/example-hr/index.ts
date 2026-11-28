/**
 * `example-hr` — an example APP DOMAIN's server half (docs/CONCEPTS.md §20).
 *
 * Read with `example-sales`, which depends on it. Everything here is one `defineDomain` call: the
 * same slots a plugin's `ServerPlugin` fills, with no manifest and no barrels — one line in
 * `apps/web/src/app.ts` wires it. Its directories: `db/` (its table), `server/` (private),
 * `ui/` (its page), and `public.ts`, the one file another domain may import.
 *
 * Delete it with `example-sales` (which depends on it): the three trees, its tests in
 * `apps/web/tests/example-hr/`, the lines in the five `app*.ts` files and its surface in
 * `.rocketflare.json`, then `pnpm db:generate`.
 */
import {
  EXAMPLE_HR_FLAG,
  EXAMPLE_HR_ID,
  EXAMPLE_HR_POLICY_SOURCE,
  EXAMPLE_LEAVE_SUBJECT,
  exampleHrShared,
} from '@rocketflare/shared/example-hr/index'
import { defineDomain, requireFeature, toolCtx } from '@/plugins/api'
import { exampleHrRouter } from './server/routes'
import { seed, seedDemo } from './server/seed'
import { exampleHrTools } from './server/tools'

export const exampleHr = defineDomain({
  id: EXAMPLE_HR_ID,
  shared: exampleHrShared,
  mounts: [['/api/example-hr', exampleHrRouter, requireFeature(EXAMPLE_HR_FLAG)]],
  tools: ctx => exampleHrTools(toolCtx(ctx)),
  /**
   * The HR-only policy collection: platform documents under `example-hr:policies`, searched by
   * `search_knowledge` only for an admin-level reader. Per-domain roles arrive with domain grants;
   * until then "HR" is whoever sees every row in the organisation.
   */
  knowledgeSources: scope => (scope.bypass ? [EXAMPLE_HR_POLICY_SOURCE] : []),
  grants: {
    owner: can => can('manage', EXAMPLE_LEAVE_SUBJECT),
    admin: can => can('manage', EXAMPLE_LEAVE_SUBJECT),
    support: can => can('read', EXAMPLE_LEAVE_SUBJECT),
    member: can => {
      can('read', EXAMPLE_LEAVE_SUBJECT)
      can('create', EXAMPLE_LEAVE_SUBJECT)
    },
  },
  hooks: {
    seed: (db, ctx) => seed({ db, ...ctx }),
    seedDemo: (db, ctx) => seedDemo({ db, ...ctx }),
  },
})
