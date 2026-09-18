/**
 * `scripts/provision/plugin-resources.ts` — what a plugin declares that the Cloudflare account has
 * to know about (D31, Decision 12). The `config` project: no database, no network, no wrangler.
 *
 * Two things here are worth more than they look. The NAMING rule is a wire format in the same sense
 * `featureBucket` is: rename a resource and provisioning creates a second one beside the live one
 * and patches the toml at it, which is a Worker pointed at an empty bucket. And the REFUSAL of an
 * unsupported binding type is the whole difference between "this kit does not do D1 yet" and a
 * Worker that deploys and 503s on its first request — so it is asserted by message, not just by
 * throwing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pluginSurfaces, readManifest } from '../../../../scripts/lib/manifest.mjs'
import {
  CLASS_PLUGIN_BINDING_TYPES,
  CREATED_PLUGIN_BINDING_TYPES,
  NAMED_PLUGIN_BINDING_TYPES,
  PluginResourceError,
  pluginBindingBlocks,
  pluginDeclarations,
  pluginKvPlaceholder,
  pluginMigrationBlocks,
  pluginMigrationTag,
  pluginResourceList,
  pluginResourceName,
  readPluginResources,
  SUPPORTED_PLUGIN_BINDING_TYPES,
  validatePluginBinding,
  validatePluginManifest,
} from '../../scripts/provision/plugin-resources'

const manifest = () =>
  validatePluginManifest(
    {
      id: 'approvals',
      bindings: [
        { type: 'kv', binding: 'APPROVALS_CACHE', name: 'cache' },
        { type: 'queue', binding: 'APPROVALS_QUEUE', name: 'jobs', consumer: true },
        { type: 'r2', binding: 'APPROVALS_FILES', name: 'files' },
      ],
      crons: ['30 * * * *'],
      apiPrefixes: ['/approvals-hook'],
      vars: [
        { key: 'APPROVALS_MAX_ITEMS', example: '50' },
        { key: 'APPROVALS_WEBHOOK_SECRET', example: '', secret: true },
      ],
    },
    'apps/web/src/plugins/approvals/plugin.json'
  )

describe('the supported set', () => {
  /**
   * The two groups PARTITION the supported list, and that is the whole shape of decision 12 now:
   * `kv`/`queue`/`r2` are CREATED (an account must hold the resource before a deploy), while
   * `workflow`/`durable_object` are DECLARED ONLY (`wrangler deploy` registers them from the block).
   * A type in neither group — or in both — would be one provisioning writes and nobody creates, or
   * one `cf-provision.sh` is handed and rightly refuses.
   */
  it('splits into created and class bindings, with nothing left over', () => {
    expect([...CREATED_PLUGIN_BINDING_TYPES, ...CLASS_PLUGIN_BINDING_TYPES].sort()).toEqual(
      [...SUPPORTED_PLUGIN_BINDING_TYPES].sort()
    )
    for (const type of CREATED_PLUGIN_BINDING_TYPES)
      expect(CLASS_PLUGIN_BINDING_TYPES).not.toContain(type)
    // Every created type also has an account-scoped name; a workflow has one WITHOUT being created,
    // which is exactly why the two lists are not the same list.
    for (const type of CREATED_PLUGIN_BINDING_TYPES)
      expect(NAMED_PLUGIN_BINDING_TYPES).toContain(type)
    expect(NAMED_PLUGIN_BINDING_TYPES).toContain('workflow')
    expect(NAMED_PLUGIN_BINDING_TYPES).not.toContain('durable_object')
  })
})

describe('naming', () => {
  it('lowercase resources are <app>-<id>-<name>[-staging]', () => {
    expect(pluginResourceName('queue', 'acme', 'approvals', 'jobs', 'production')).toBe(
      'acme-approvals-jobs'
    )
    expect(pluginResourceName('queue', 'acme', 'approvals', 'jobs', 'staging')).toBe(
      'acme-approvals-jobs-staging'
    )
    expect(pluginResourceName('r2', 'acme', 'approvals', 'files', 'staging')).toBe(
      'acme-approvals-files-staging'
    )
  })

  it('KV follows the kit’s own uppercase convention, <APP>_<ID>_<NAME>[_STAGING]', () => {
    // The kit's namespace is `<APP>_RATE_LIMIT[_STAGING]`; a plugin's must read like the rest of
    // the account rather than like a different tool made it.
    expect(pluginResourceName('kv', 'acme-web', 'approvals', 'cache', 'production')).toBe(
      'ACME_WEB_APPROVALS_CACHE'
    )
    expect(pluginResourceName('kv', 'acme-web', 'approvals', 'cache', 'staging')).toBe(
      'ACME_WEB_APPROVALS_CACHE_STAGING'
    )
  })

  it('the staging name always differs and carries the account-scoping suffix', () => {
    // Only the types that HAVE an account-scoped resource name. A `durable_object` has none — its
    // block is byte-identical in both files — so asserting a suffix for it would be asserting
    // something about a string nothing reads.
    for (const type of NAMED_PLUGIN_BINDING_TYPES) {
      const prod = pluginResourceName(type, 'acme', 'approvals', 'jobs', 'production')
      const staging = pluginResourceName(type, 'acme', 'approvals', 'jobs', 'staging')
      expect(staging).not.toBe(prod)
      expect(staging).toMatch(/[-_](staging|STAGING)$/)
    }
  })

  it('the KV placeholder is spelled like the kit’s, so tomlPlaceholders sees it', () => {
    expect(pluginKvPlaceholder('approvals', 'cache', 'production')).toBe('<KV_APPROVALS_CACHE_ID>')
    expect(pluginKvPlaceholder('approvals', 'cache', 'staging')).toBe(
      '<KV_APPROVALS_CACHE_STAGING_ID>'
    )
    for (const p of [
      pluginKvPlaceholder('approvals', 'cache', 'production'),
      pluginKvPlaceholder('approvals', 'cache', 'staging'),
    ])
      expect(p).toMatch(/^<[A-Z0-9_]+>$/)
  })
})

describe('validation', () => {
  it('names the unsupported type rather than skipping it', () => {
    expect(() =>
      validatePluginBinding('approvals', { type: 'd1', binding: 'DB', name: 'main' })
    ).toThrowError(
      /binding type "d1" is not provisioned by this kit \(supported: kv, queue, r2, workflow, durable_object\)/
    )
  })

  /**
   * The two types that graduated with the sixth barrel, and the three fields that make each block
   * writable at all. A `class_name` resolves against the named exports of `src/worker.ts`, so a
   * block naming a class nothing exports makes `wrangler deploy` refuse the whole SCRIPT — which
   * is why the manifest has to say which class, and why `plugin check` proves it is exported.
   */
  it('validates a workflow and a durable object', () => {
    expect(
      validatePluginBinding('orders', {
        type: 'workflow',
        binding: 'ORDERS_SYNC',
        name: 'sync',
        className: 'OrdersSyncWorkflow',
      })
    ).toEqual({
      type: 'workflow',
      binding: 'ORDERS_SYNC',
      name: 'sync',
      className: 'OrdersSyncWorkflow',
    })
    expect(
      validatePluginBinding('orders', {
        type: 'durable_object',
        binding: 'ORDERS_HUB',
        className: 'OrdersHub',
        storage: 'sqlite',
      })
    ).toEqual({
      type: 'durable_object',
      binding: 'ORDERS_HUB',
      name: '',
      className: 'OrdersHub',
      storage: 'sqlite',
    })
  })

  it.each([
    [{ type: 'workflow', binding: 'W', name: 'w' }, /must declare className/],
    [{ type: 'durable_object', binding: 'H', className: 'H' }, /storage must be sqlite \| none/],
    [{ type: 'durable_object', binding: 'H', className: 'H', storage: 'kv' }, /storage must be/],
    // A DO creates no resource, so a `name` there is a value nothing would ever read.
    [
      { type: 'durable_object', binding: 'H', name: 'hub', className: 'H', storage: 'sqlite' },
      /no account-scoped name/,
    ],
    [{ type: 'kv', binding: 'K', name: 'k', className: 'K' }, /only meaningful on a class binding/],
    [{ type: 'workflow', binding: 'W', className: 'W' }, /must match/],
  ])('refuses %j', (raw, message) => {
    expect(() => validatePluginBinding('orders', raw)).toThrowError(message)
  })

  it('refuses hyperdrive from a plugin — the host owns the one database', () => {
    expect(() =>
      validatePluginBinding('approvals', { type: 'hyperdrive', binding: 'X', name: 'y' })
    ).toThrowError(PluginResourceError)
  })

  it.each([
    [{ type: 'kv', binding: 'lower_case', name: 'cache' }, /binding name/],
    [{ type: 'kv', binding: 'CACHE', name: 'Cache' }, /must match/],
    [{ type: 'kv', binding: 'CACHE', name: 'cache', consumer: true }, /only meaningful on a queue/],
    [{ binding: 'CACHE', name: 'cache' }, /has no `type`/],
  ])('refuses %j', (raw, message) => {
    expect(() => validatePluginBinding('approvals', raw)).toThrowError(message)
  })

  it('refuses one plugin declaring the same binding twice', () => {
    expect(() =>
      validatePluginManifest(
        {
          id: 'approvals',
          bindings: [
            { type: 'kv', binding: 'X', name: 'a' },
            { type: 'r2', binding: 'X', name: 'b' },
          ],
        },
        'anchor'
      )
    ).toThrowError(/declares binding "X" twice/)
  })

  it('a manifest with no platform declarations validates to four empty lists', () => {
    const m = validatePluginManifest({ id: 'plain' }, 'anchor')
    expect(m).toEqual({
      id: 'plain',
      anchor: 'anchor',
      bindings: [],
      crons: [],
      apiPrefixes: [],
      vars: [],
    })
  })

  it('a var defaults to non-secret with an empty example', () => {
    const m = validatePluginManifest({ id: 'p', vars: [{ key: 'A_KEY' }] }, 'anchor')
    expect(m.vars).toEqual([{ key: 'A_KEY', example: '', secret: false }])
  })
})

describe('the resource list', () => {
  it('names every binding for one environment', () => {
    expect(pluginResourceList('acme', [manifest()], 'staging')).toEqual([
      { type: 'kv', name: 'ACME_APPROVALS_CACHE_STAGING', binding: 'APPROVALS_CACHE' },
      { type: 'queue', name: 'acme-approvals-jobs-staging', binding: 'APPROVALS_QUEUE' },
      { type: 'r2', name: 'acme-approvals-files-staging', binding: 'APPROVALS_FILES' },
    ])
  })

  it('refuses two plugins claiming one binding name', () => {
    const other = validatePluginManifest(
      { id: 'billing', bindings: [{ type: 'r2', binding: 'APPROVALS_CACHE', name: 'files' }] },
      'anchor'
    )
    expect(() => pluginResourceList('acme', [manifest(), other], 'production')).toThrowError(
      /declared by both "approvals" and "billing"/
    )
  })

  it('is empty for a checkout with no plugins', () => {
    expect(pluginResourceList('acme', [], 'production')).toEqual([])
    expect(pluginDeclarations([])).toEqual({ crons: [], apiPrefixes: [], vars: [] })
  })
})

// ---- reading what is installed ------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-plugin-res-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writeAnchor(id: string, body: unknown): string {
  const rel = `apps/web/src/plugins/${id}/plugin.json`
  fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), JSON.stringify(body))
  return rel
}

describe('readPluginResources', () => {
  it('reads plugin surfaces and ignores every other kind', () => {
    const anchor = writeAnchor('approvals', {
      id: 'approvals',
      bindings: [{ type: 'kv', binding: 'APPROVALS_CACHE', name: 'cache' }],
    })
    const read = readPluginResources(tmp, [
      { id: 'chat', kind: 'optional-feature', anchor: 'apps/web/src/api/routes/chat.ts' },
      { id: 'approvals', kind: 'plugin', anchor },
    ])
    expect(read.map(p => p.id)).toEqual(['approvals'])
    expect(read[0].bindings[0].binding).toBe('APPROVALS_CACHE')
  })

  it('a deleted directory contributes nothing — presence is existsSync on the anchor', () => {
    expect(
      readPluginResources(tmp, [
        { id: 'gone', kind: 'plugin', anchor: 'apps/web/src/plugins/gone/plugin.json' },
      ])
    ).toEqual([])
  })

  it('the kit’s own installed plugins declare only things this kit can provision', () => {
    // Against the REAL checkout: `example-feature` declares nothing today, and the day one of them
    // declares a binding this is what proves the declaration is well formed before a deploy does.
    // Through `readManifest()`, never a literal filename: it is the one place the manifest and its
    // git-ignored sidecar are read, so a plugin installed with `--local` is covered here too.
    const repoRoot = path.resolve(__dirname, '../../../..')
    const { manifest } = readManifest(repoRoot)
    expect(() => readPluginResources(repoRoot, pluginSurfaces(manifest))).not.toThrow()
  })
})

/**
 * The ONE mapping from a declaration to a `[[…]]` block. `pnpm provision cloudflare <env>` and the
 * parity test's fixture both read it, so they cannot disagree about what provisioning writes —
 * which they could, and did, when each built its own blocks.
 */
describe('the blocks provisioning writes', () => {
  const classy = () =>
    validatePluginManifest(
      {
        id: 'orders',
        bindings: [
          { type: 'kv', binding: 'ORDERS_CACHE', name: 'cache' },
          {
            type: 'workflow',
            binding: 'ORDERS_SYNC',
            name: 'sync',
            className: 'OrdersSyncWorkflow',
          },
          {
            type: 'durable_object',
            binding: 'ORDERS_HUB',
            className: 'OrdersHub',
            storage: 'sqlite',
          },
          {
            type: 'durable_object',
            binding: 'ORDERS_LOG',
            className: 'OrdersLog',
            storage: 'none',
          },
        ],
      },
      'apps/web/src/plugins/orders/plugin.json'
    )

  it('creates only what an account has to create', () => {
    // A workflow and a Durable Object are registered by `wrangler deploy` from the block
    // provisioning already wrote, so neither reaches `cf-provision.sh` — which is right to refuse
    // a type it cannot create.
    expect(pluginResourceList('acme', [classy()], 'staging').map(r => r.binding)).toEqual([
      'ORDERS_CACHE',
    ])
  })

  it('gives a workflow an account-scoped name and a DO none at all', () => {
    const blocks = pluginBindingBlocks('acme', [classy()], 'staging')
    expect(blocks.find(b => b.binding === 'ORDERS_SYNC')).toEqual({
      type: 'workflow',
      binding: 'ORDERS_SYNC',
      pluginId: 'orders',
      name: 'acme-orders-sync-staging',
      className: 'OrdersSyncWorkflow',
    })
    // The incident in docs/DEPLOY.md is a shared Workflow name running one environment's instances
    // against the other's database, with nothing erroring. The suffix is what prevents it.
    expect(
      pluginBindingBlocks('acme', [classy()], 'production').find(b => b.binding === 'ORDERS_SYNC')
        ?.name
    ).toBe('acme-orders-sync')
    expect(blocks.find(b => b.binding === 'ORDERS_HUB')).toEqual({
      type: 'durable_object',
      binding: 'ORDERS_HUB',
      pluginId: 'orders',
      className: 'OrdersHub',
    })
    // A KV block carries the placeholder, because the block must exist before an id can be
    // patched into it.
    expect(blocks.find(b => b.binding === 'ORDERS_CACHE')?.id).toBe('<KV_ORDERS_CACHE_STAGING_ID>')
  })

  it('writes ONE install migration per plugin, split by declared storage', () => {
    expect(pluginMigrationBlocks([classy()])).toEqual([
      {
        tag: pluginMigrationTag('orders'),
        pluginId: 'orders',
        newClasses: ['OrdersLog'],
        newSqliteClasses: ['OrdersHub'],
      },
    ])
    // A plugin with no Durable Object needs no migration at all — an empty `[[migrations]]` entry
    // would be a tag claiming something Cloudflare never has to do.
    expect(pluginMigrationBlocks([manifest()])).toEqual([])
  })
})
