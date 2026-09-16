/**
 * The plugin's lifecycle hooks (D31): what a new organisation starts with, and what
 * `pnpm seed --demo` fills in.
 *
 * Both obey the kit's hook contract, which is one sentence: **idempotent, post-commit,
 * best-effort.** `onTenantCreated` runs outside the create transaction and its failure is swallowed
 * by the host, so it must never be the only way a tenant gets something it needs — here the welcome
 * note is decoration, and a tenant without one works perfectly. `seedDemo` is handed a `demoId`
 * already namespaced with the plugin's id, so two plugins that both seed `note:1` cannot collide
 * and re-running the seed adds nothing.
 */

import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import { eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
// Named directly rather than through `db/schema/index.ts`: that barrel re-exports THIS plugin's
// tables, so importing it from inside the plugin is a cycle back through `plugins/schema`.
import { featureFlags } from '../../../db/schema/feature-flags'
import type { PluginSeedContext } from '../../types'
import { exampleNotes } from '../db/schema'

/**
 * A new organisation gets one note, so the page is never empty on first view. Idempotent by
 * construction: it inserts only when the tenant has none, which is also what makes it safe if the
 * host ever retries the hook.
 */
export async function onTenantCreated(db: Database, tenantId: string): Promise<void> {
  const existing = await db.$count(exampleNotes, eq(exampleNotes.tenantId, tenantId))
  if (existing > 0) return
  await db.insert(exampleNotes).values({
    tenantId,
    ownerUserId: null,
    title: 'Welcome to the example feature',
    body:
      'This note was written by the example-feature plugin’s onTenantCreated hook. Everything ' +
      'about this feature — the flag, this table, its route, its agent tool and its CLI commands — ' +
      'lives in apps/web/src/plugins/example-feature and is safe to delete.',
  })
}

/**
 * `pnpm seed --demo`. Two notes with fixed ids, plus the demo flag mid-rollout so `/admin` has
 * something to show — deliberately `rollout` rather than `on`, because a percentage is the state
 * whose behaviour is worth seeing, and 50% counted in organisations means this tenant may or may
 * not have it, which is the honest demonstration of a deterministic bucket rather than a bug.
 *
 * The flag row moved here from the kit's seed with the rest of the plugin: a flag belongs to
 * whatever ships it, and a kit with this plugin removed must not seed state for a key no code reads.
 */
export async function seedDemo(db: Database, ctx: PluginSeedContext): Promise<void> {
  await db
    .insert(exampleNotes)
    .values([
      {
        id: ctx.demoId('note:depot-handover'),
        tenantId: ctx.tenantId,
        ownerUserId: ctx.ownerId,
        title: 'Depot handover checklist',
        body: 'Seal numbers photographed, temperature log signed, exceptions raised before the driver leaves.',
      },
      {
        id: ctx.demoId('note:peak-season'),
        tenantId: ctx.tenantId,
        ownerUserId: ctx.ownerId,
        title: 'Peak season staffing',
        body: 'Two extra pickers on the late shift from week 46; review weekly against the despatch backlog.',
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(featureFlags)
    .values({
      key: EXAMPLE_FEATURE_FLAG,
      state: 'rollout',
      rolloutPercent: 50,
      rolloutUnit: 'tenant',
    })
    .onConflictDoNothing()
  ctx.log('2 notes, example-feature flag at 50% rollout')
}
