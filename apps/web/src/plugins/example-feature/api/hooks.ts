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
 *
 * Note what `HookCtx` does NOT carry: a logger, an `env`, a way to enqueue or nudge. A hook runs at
 * somebody else's transaction boundary and has no business doing any of that — if it needs to, it is
 * not a hook.
 */

import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import { eq } from 'drizzle-orm'
import type { HookCtx, SeedCtx } from '@/plugins/api'
import { allTables } from '@/plugins/api/peers'
import { exampleNotes } from '../db/schema'

/**
 * A new organisation gets one note, so the page is never empty on first view. Idempotent by
 * construction: it inserts only when the tenant has none, which is also what makes it safe if the
 * host ever retries the hook.
 */
export async function onTenantCreated({ db, tenantId }: HookCtx): Promise<void> {
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
 * The flag row belongs to whatever SHIPS the flag, which is this plugin: a kit with this plugin
 * removed must not seed state for a key no code reads. `feature_flags` is the KIT's table, though,
 * so it is reached through `allTables()` — the declared way to name the merged schema — and
 * **called inside the function rather than at module scope**, because that module reads the plugin
 * barrel and a module-scope call closes the cycle with one side still `undefined`.
 */
export async function seedDemo(ctx: SeedCtx): Promise<void> {
  const { featureFlags } = allTables()
  await ctx.db
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
  await ctx.db
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
