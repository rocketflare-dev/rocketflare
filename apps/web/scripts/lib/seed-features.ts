/**
 * Per-organisation feature flags from `pnpm seed`, and the plugin seed hooks that may set them.
 *
 * Two ways in, one writer (`setTenantOverride`, the same function `/admin/feature-flags` uses):
 *
 * - `pnpm seed --feature <key>[=on|off][@<tenant-slug>]` (repeatable): an override on the seeded
 *   tenant, or on the tenant with that slug. `on` is the default.
 * - A plugin's `hooks.seed` / `hooks.seedDemo` calls `ctx.setFeature(key, enabled?, tenantId?)` —
 *   so reference data a plugin needs, and the flag that shows it, arrive with plain `pnpm seed`.
 *
 * An unknown key is refused by name, with the registry's keys: an override on a key nobody
 * declared would be a row the app never reads.
 */
import { FEATURE_KEYS } from '@rocketflare/shared/features'
import type { FeatureName } from '@rocketflare/shared/permissions'
import { eq } from 'drizzle-orm'
import { setTenantOverride } from '../../src/api/services/features'
import type { Database } from '../../src/db/client'
import { tenants } from '../../src/db/schema'
import type { AnyServerPlugin, PluginSeedContext } from '../../src/plugins/types'

export interface SeedFeatureRequest {
  key: string
  enabled: boolean
  /** `undefined` = the seeded tenant. */
  tenantSlug?: string
}

/** Every `--feature` on the command line (`--feature x` or `--feature=x`), parsed. */
export function parseSeedFeatureArgs(argv: readonly string[]): SeedFeatureRequest[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--feature') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--feature needs a value: --feature <key>[=on|off][@<tenant-slug>]')
      }
      values.push(next)
      i++
    } else if (arg.startsWith('--feature=')) {
      values.push(arg.slice('--feature='.length))
    }
  }
  return values.map(parseOne)
}

function parseOne(value: string): SeedFeatureRequest {
  const match = /^([^=@\s]+)(?:=(on|off))?(?:@([a-z0-9-]+))?$/.exec(value)
  if (!match?.[1]) {
    throw new Error(`--feature ${value}: expected <key>[=on|off][@<tenant-slug>]`)
  }
  return {
    key: match[1],
    enabled: match[2] !== 'off',
    ...(match[3] ? { tenantSlug: match[3] } : {}),
  }
}

/** The key as a registered flag, or an error naming the keys that exist. */
export function featureKey(key: string): FeatureName {
  if ((FEATURE_KEYS as readonly string[]).includes(key)) return key as FeatureName
  const known = FEATURE_KEYS.length > 0 ? FEATURE_KEYS.join(', ') : 'none registered'
  throw new Error(`unknown feature flag "${key}" (known: ${known})`)
}

/** `ctx.setFeature`: an override on `tenantId` (default: the seeded tenant), set by `setByUserId`. */
export function seedFeatureSetter(
  db: Database,
  defaultTenantId: string,
  setByUserId: string
): PluginSeedContext['setFeature'] {
  return async (key, enabled = true, tenantId = defaultTenantId) => {
    await setTenantOverride(db, featureKey(key), tenantId, enabled, setByUserId)
  }
}

/** Apply the command line's `--feature` requests; answers one log line per override. */
export async function applySeedFeatures(
  db: Database,
  requests: readonly SeedFeatureRequest[],
  seeded: { id: string; slug: string },
  setByUserId: string
): Promise<string[]> {
  const lines: string[] = []
  for (const request of requests) {
    const key = featureKey(request.key)
    let tenant = seeded
    if (request.tenantSlug && request.tenantSlug !== seeded.slug) {
      const found = await db.query.tenants.findFirst({
        where: eq(tenants.slug, request.tenantSlug),
      })
      if (!found)
        throw new Error(`--feature ${key}@${request.tenantSlug}: no tenant with that slug`)
      tenant = { id: found.id, slug: found.slug }
    }
    await setTenantOverride(db, key, tenant.id, request.enabled, setByUserId)
    lines.push(`  feature ${key.padEnd(24)} ${request.enabled ? 'on' : 'off'} for ${tenant.slug}`)
  }
  return lines
}

/**
 * Run one seed hook across the installed plugins, in barrel order. One plugin's failure is
 * reported and the rest still run — a half-seeded workspace beats none.
 */
export async function runPluginSeedHooks(
  plugins: readonly AnyServerPlugin[],
  hook: 'seed' | 'seedDemo',
  db: Database,
  context: (plugin: AnyServerPlugin) => PluginSeedContext,
  log: (line: string) => void
): Promise<void> {
  for (const plugin of plugins) {
    const run = plugin.hooks?.[hook]
    if (!run) continue
    try {
      await run(db, context(plugin))
    } catch (error) {
      log(`  ${plugin.shared.id.padEnd(7)} FAILED: ${(error as Error).message}`)
    }
  }
}
