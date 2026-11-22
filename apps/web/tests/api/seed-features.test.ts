/**
 * The seed's per-organisation flags: `--feature` overrides (the seeded tenant, or one named by
 * slug) and a plugin's `hooks.seed` calling `ctx.setFeature` — each a `tenant_feature_overrides`
 * row on exactly the tenant it names, and the flag then on in that tenant's features and no other.
 */
import { FEATURE_FLAGS, FEATURE_KEYS, type FeatureDefinition } from '@rocketflare/shared/features'
import type { FeatureName } from '@rocketflare/shared/permissions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tenantFeatures } from '@/api/services/features'
import { loadConfig } from '@/config'
import { tenantFeatureOverrides } from '@/db/schema'
import type { AnyServerPlugin, PluginSeedContext } from '@/plugins/types'
import {
  applySeedFeatures,
  runPluginSeedHooks,
  seedFeatureSetter,
} from '../../scripts/lib/seed-features'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const KEY = 'seed-features-test-fixture' as unknown as FeatureName

beforeAll(() => {
  ;(FEATURE_FLAGS as Record<string, FeatureDefinition>)[KEY] = {
    label: 'Seed features fixture',
    description: 'Registered by tests/api/seed-features.test.ts',
    defaultState: 'off',
    defaultRolloutUnit: 'tenant',
    environmentGated: false,
  }
  FEATURE_KEYS.push(KEY)
})

// `api` shares a module registry, so the fixture key must not outlive this file; its override
// rows go with it (the tenants are this file's own, but the key is not).
afterAll(async () => {
  await db.delete(tenantFeatureOverrides).where(eq(tenantFeatureOverrides.flagKey, KEY))
  delete (FEATURE_FLAGS as Record<string, FeatureDefinition>)[KEY]
  FEATURE_KEYS.splice(FEATURE_KEYS.indexOf(KEY), 1)
})

async function override(tenantId: string) {
  const [row] = await db
    .select({ enabled: tenantFeatureOverrides.enabled })
    .from(tenantFeatureOverrides)
    .where(
      and(eq(tenantFeatureOverrides.tenantId, tenantId), eq(tenantFeatureOverrides.flagKey, KEY))
    )
  return row?.enabled ?? null
}

describe('seed --feature', () => {
  it('turns a flag on for the seeded tenant, and off for another named by slug', async () => {
    const seeded = await createTestTenantWithUser(db)
    const other = await createTestTenantWithUser(db)
    const lines = await applySeedFeatures(
      db,
      [
        { key: KEY, enabled: true },
        { key: KEY, enabled: false, tenantSlug: other.tenant.slug },
      ],
      seeded.tenant,
      seeded.user.id
    )
    expect(await override(seeded.tenant.id)).toBe(true)
    expect(await override(other.tenant.id)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`feature ${KEY} +on for ${seeded.tenant.slug}$`)),
      expect.stringMatching(new RegExp(`feature ${KEY} +off for ${other.tenant.slug}$`)),
    ])
    expect(await tenantFeatures(db, cfg, seeded.tenant.id)).toContain(KEY)
    expect(await tenantFeatures(db, cfg, other.tenant.id)).not.toContain(KEY)
  })

  it('refuses an unknown slug and an unknown key, writing nothing', async () => {
    const seeded = await createTestTenantWithUser(db)
    await expect(
      applySeedFeatures(
        db,
        [{ key: KEY, enabled: true, tenantSlug: 'no-such-tenant-slug' }],
        seeded.tenant,
        seeded.user.id
      )
    ).rejects.toThrow(/no tenant with that slug/)
    await expect(
      applySeedFeatures(db, [{ key: 'nope', enabled: true }], seeded.tenant, seeded.user.id)
    ).rejects.toThrow(/unknown feature flag "nope"/)
    expect(await override(seeded.tenant.id)).toBeNull()
  })
})

describe('hooks.seed', () => {
  it("runs each plugin's hook with setFeature bound to the seeded tenant; a failure is logged", async () => {
    const seeded = await createTestTenantWithUser(db)
    const ran: string[] = []
    const plugins = [
      {
        shared: { id: 'broken' },
        hooks: {
          seed: async () => {
            throw new Error('boom')
          },
        },
      },
      {
        shared: { id: 'hotel' },
        hooks: {
          seed: async (_db: unknown, ctx: PluginSeedContext) => {
            ran.push(ctx.tenantId)
            await ctx.setFeature(KEY)
          },
          seedDemo: async () => {
            ran.push('demo')
          },
        },
      },
    ] as unknown as AnyServerPlugin[]
    const log: string[] = []
    await runPluginSeedHooks(
      plugins,
      'seed',
      db,
      plugin => ({
        tenantId: seeded.tenant.id,
        ownerId: seeded.user.id,
        demoId: key => `${plugin.shared.id}:${key}`,
        log: line => log.push(line),
        setFeature: seedFeatureSetter(db, seeded.tenant.id, seeded.user.id),
      }),
      line => log.push(line)
    )
    expect(ran).toEqual([seeded.tenant.id])
    expect(log).toEqual([expect.stringMatching(/broken +FAILED: boom/)])
    expect(await override(seeded.tenant.id)).toBe(true)
  })
})
