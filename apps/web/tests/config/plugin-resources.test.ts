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
import {
  PluginResourceError,
  pluginDeclarations,
  pluginKvPlaceholder,
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
    for (const type of SUPPORTED_PLUGIN_BINDING_TYPES) {
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
    ).toThrowError(/binding type "d1" is not provisioned by this kit \(supported: kv, queue, r2\)/)
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
    const repoRoot = path.resolve(__dirname, '../../../..')
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, '.rocketflare.json'), 'utf8'))
    expect(() => readPluginResources(repoRoot, raw.surfaces ?? [])).not.toThrow()
  })
})
