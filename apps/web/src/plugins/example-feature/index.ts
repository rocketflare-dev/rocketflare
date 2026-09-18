/**
 * `example-feature` — the reference plugin's SERVER entry (D31, decision 3).
 *
 * One of the four published files a plugin has (this, `./ui`, the shared entry and the CLI one);
 * everything else under this directory is private, which is what lets the plugin's own semver cover
 * a knowable surface. `tests/config/plugins.test.ts` enforces that: nothing outside the plugin may
 * name a file inside it except the five barrel lines.
 *
 * Read this file top to bottom and you have the whole server half: which prefix it mounts and
 * behind which gate, which job types it handles, which tools it gives every agent run, what a new
 * organisation and the demo seed get, and which CASL rules it adds. The host merges each of those
 * into a kit registry it cannot otherwise be edited into.
 *
 * **It is also the boundary.** The registration slots below are the kit's shapes, and the plugin's
 * own code is written against the plugin surface — so the adapters (`toolCtx`, and the two hook
 * spreads) are called here, once each, and nowhere else. That is the sentence the whole contract
 * makes true: *a plugin imports only from declared entries, and receives everything else as
 * injected context.*
 */

import {
  EXAMPLE_FEATURE_FLAG,
  EXAMPLE_NOTE_SUBJECT,
  EXAMPLE_PING_JOB,
  exampleFeatureShared,
} from '@rocketflare/shared/plugins/example-feature/index'
import type { ServerPlugin, Tool } from '@/plugins/api'
import { requireFeature, toolCtx } from '@/plugins/api'
import { onTenantCreated, seedDemo } from './api/hooks'
import { exampleFeatureRouter } from './api/routes'
import { handleExamplePing } from './jobs/ping'
import { listExampleNotesTool } from './tools/list-example-notes'

export const exampleFeatureServer = {
  shared: exampleFeatureShared,
  /**
   * **The flag gates the MOUNT, not each route** (D30). One middleware beneath the whole prefix
   * means a surface that ships dark is dark as a whole, declared once like auth — and it answers
   * 404 `feature_disabled` rather than 403, because a 403 confirms the feature exists. It reads
   * `auth.features`, never the ability: a global admin's `manage all` covers `access` on every
   * `Feature:` subject, which is exactly how platform staff end up inside an unreleased surface.
   */
  mounts: [['/api/example-feature', exampleFeatureRouter, requireFeature(EXAMPLE_FEATURE_FLAG)]],
  jobHandlers: { [EXAMPLE_PING_JOB]: handleExamplePing },
  /**
   * The tool is written against `ToolCtx`; `toolCtx` adapts the runtime's context at this one
   * boundary. The scope inside it carries the tenant AND what the run's REQUESTER may read, which
   * is why a tool never takes a tenant id of its own.
   */
  agentTools: ctx => [listExampleNotesTool(toolCtx(ctx)) as Tool],
  /**
   * Additive only, and over this plugin's OWN subject. CASL can take a rule back only with
   * `cannot`, so a plugin that revoked a kit grant would change what every role may do merely by
   * being installed. The shape follows the kit's matrix: admin-level roles `manage`, a member may
   * read and create, and "is this row yours" stays the route's own `ownerUserId` check.
   */
  grants: {
    owner: can => can('manage', EXAMPLE_NOTE_SUBJECT),
    admin: can => can('manage', EXAMPLE_NOTE_SUBJECT),
    support: can => can('manage', EXAMPLE_NOTE_SUBJECT),
    member: can => {
      can('read', EXAMPLE_NOTE_SUBJECT)
      can('create', EXAMPLE_NOTE_SUBJECT)
    },
  },
  hooks: {
    onTenantCreated: (db, tenant, userId, features) =>
      onTenantCreated({ db, tenant, tenantId: tenant.id, userId, features }),
    seedDemo: (db, ctx) =>
      seedDemo({
        db,
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        demoId: ctx.demoId,
        log: ctx.log,
      }),
  },
} satisfies ServerPlugin<typeof exampleFeatureShared>
