/**
 * wrangler.toml ⇄ wrangler.staging.toml parity.
 *
 * The kit deploys two standalone Worker configs (D6): `[env.*]` does not inherit bindings, so the
 * two files are copies that must differ ONLY in name, routes, `[vars]` values and resource ids.
 * Everything application code can observe — binding names, DO class names, compatibility date
 * and flags, `[limits]`, crons, `[assets]` — must be identical, or a Worker behaves differently
 * in staging and production. Account-scoped resource names (Workflow `name`, queue `queue`, R2
 * `bucket_name`) must additionally DIFFER, because the last deployer of a shared Workflow name
 * owns it and runs the other environment's instances under its own bindings.
 *
 * Placeholder check: `<HYPERDRIVE_ID>`-style tokens are allowed while the kit is unprovisioned, so
 * PR CI (`ci.yml`) stays green on a fresh copy. The deploy workflow sets `REQUIRE_PROVISIONED=1`
 * before its test step and the placeholder `describe` runs only then. See docs/DEPLOY.md.
 */

import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import { WORKER_FIRST_PATTERNS } from '@/api/utils/routes/api-prefixes'
import { pluginSurfaces, readManifest } from '../../../../scripts/lib/manifest.mjs'
import { patchToml } from '../../scripts/provision/patch-toml'
import {
  pluginParityIssues,
  pluginResourceName,
  readPluginResources,
  validatePluginManifest,
} from '../../scripts/provision/plugin-resources'

type Toml = Record<string, unknown>
type Row = Record<string, unknown>

// apps/web — resolved from this file's location, NOT process.cwd(), so the test reads the same
// tomls whether vitest is started from the workspace root (`pnpm test`) or from apps/web.
const WEB_DIR = path.resolve(__dirname, '../..')
const read = (file: string): Toml =>
  TOML.parse(fs.readFileSync(path.join(WEB_DIR, file), 'utf8')) as Toml

const prod = read('wrangler.toml')
const staging = read('wrangler.staging.toml')

// What this checkout actually has installed. Through `readManifest()` rather than a literal
// filename — the one place the manifest and its git-ignored sidecar are read, so a `--local`
// install is held to the same parity rules. At module scope because two describes need it.
const REPO_ROOT = path.resolve(WEB_DIR, '../..')
const installed = readPluginResources(
  REPO_ROOT,
  pluginSurfaces(readManifest(REPO_ROOT).manifest) as Array<{
    id: string
    kind: string
    anchor: string
  }>
)

/** The run_worker_first patterns an installed plugin contributes, rather than the kit itself. */
const PLUGIN_WORKER_FIRST = new Set(
  installed.flatMap(p => p.apiPrefixes.flatMap(prefix => [prefix, `${prefix}/*`]))
)

// ---- helpers ----------------------------------------------------------------------------

const get = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Row)[key]
    return undefined
  }, obj)

const rows = (obj: Toml, dotted: string): Row[] => {
  const v = get(obj, dotted)
  return Array.isArray(v) ? (v as Row[]) : []
}

/** Sorted projection of an array-of-tables section, keeping only environment-invariant keys. */
const shape = (obj: Toml, section: string, keys: string[]): Row[] =>
  rows(obj, section)
    .map(r => Object.fromEntries(keys.map(k => [k, r[k]])))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

const names = (obj: Toml, section: string, key: string): string[] =>
  rows(obj, section)
    .map(r => String(r[key]))
    .sort()

/** Every string value in the parsed document (comments are gone after parsing). */
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

const PLACEHOLDER = /^<[A-Z0-9_]+>$/

// Sections whose *binding names + class names* must match. `keys` are the environment-invariant
// fields (what code sees); `scopedKey` is the account-scoped resource name that must differ.
const BINDING_SECTIONS: Array<{ section: string; keys: string[]; scopedKey?: string }> = [
  { section: 'kv_namespaces', keys: ['binding'] },
  { section: 'hyperdrive', keys: ['binding'] },
  { section: 'queues.producers', keys: ['binding'], scopedKey: 'queue' },
  {
    section: 'queues.consumers',
    keys: ['max_batch_size', 'max_batch_timeout', 'max_retries', 'retry_delay'],
    scopedKey: 'queue',
  },
  { section: 'durable_objects.bindings', keys: ['name', 'class_name'] },
  { section: 'workflows', keys: ['binding', 'class_name'], scopedKey: 'name' },
  { section: 'r2_buckets', keys: ['binding'], scopedKey: 'bucket_name' },
  { section: 'analytics_engine_datasets', keys: ['binding'], scopedKey: 'dataset' },
]

// ---- must match -------------------------------------------------------------------------

describe('wrangler parity: must match', () => {
  it.each([
    'main',
    'compatibility_date',
    'compatibility_flags',
    'limits',
    'placement',
    'observability',
    'assets',
  ])('top-level `%s` is identical', key => {
    expect(staging[key]).toEqual(prod[key])
  })

  it('[triggers].crons are identical', () => {
    expect(get(staging, 'triggers.crons')).toEqual(get(prod, 'triggers.crons'))
  })

  it('[vars] declare the same KEYS (values may differ)', () => {
    const keys = (o: Toml) => Object.keys((o.vars as Row) ?? {}).sort()
    expect(keys(staging)).toEqual(keys(prod))
  })

  it('[vars].APP_ENV is production / staging respectively', () => {
    expect(get(prod, 'vars.APP_ENV')).toBe('production')
    expect(get(staging, 'vars.APP_ENV')).toBe('staging')
  })

  it.each(BINDING_SECTIONS)('$section: same binding names and classes', ({ section, keys }) => {
    expect(shape(staging, section, keys)).toEqual(shape(prod, section, keys))
  })

  it('[ai] binding (when present) is identical', () => {
    expect(get(staging, 'ai.binding')).toEqual(get(prod, 'ai.binding'))
  })

  it('[[migrations]] (Durable Object class migrations) are identical', () => {
    expect(staging.migrations).toEqual(prod.migrations)
  })

  it('every Durable Object class_name is identical and in-script (no script_name)', () => {
    const cls = (o: Toml) => names(o, 'durable_objects.bindings', 'class_name')
    expect(cls(staging)).toEqual(cls(prod))
    for (const r of [
      ...rows(prod, 'durable_objects.bindings'),
      ...rows(staging, 'durable_objects.bindings'),
    ]) {
      expect(
        r.script_name,
        'DO hub lives in this worker; a cross-script binding is a different design'
      ).toBeUndefined()
    }
  })

  it('[assets] routes every Worker-owned prefix to the Worker FIRST', () => {
    // The asset router runs BEFORE the Worker, and `single-page-application` answers anything it
    // considers a NAVIGATION with index.html without invoking `fetch`. An `<object>` embed and an
    // `<a download>` click are navigations, so a prefix missing here is silently served the app
    // shell for exactly those requests — while every API test still passes, because they drive the
    // Hono app directly and never reach the asset router. This assertion is the only thing that
    // catches it, so it is an equality against the one list `isApiPath` uses, not a subset check.
    for (const [label, config] of [
      ['production', prod],
      ['staging', staging],
    ] as const) {
      expect(get(config, 'assets.not_found_handling'), label).toBe('single-page-application')
      // Equality, not a subset — but over the prefixes the KIT owns. WORKER_FIRST_PATTERNS is
      // built from the server barrel, so an installed plugin inflates it while the toml stays bare
      // until `provision cloudflare` writes them (D31, decision 12). Subtracting the plugin's
      // patterns from both sides keeps this exact where it protects something, and silent where
      // provisioning rather than the kit fills the gap; `pluginParityIssues` under
      // REQUIRE_PROVISIONED=1 is what demands the plugin half.
      const workerFirst = (get(config, 'assets.run_worker_first') ?? []) as string[]
      expect(
        workerFirst.filter(pattern => !PLUGIN_WORKER_FIRST.has(pattern)),
        label
      ).toEqual(WORKER_FIRST_PATTERNS.filter(pattern => !PLUGIN_WORKER_FIRST.has(pattern)))
    }
  })

  it('both files declare the baseline bindings', () => {
    expect(names(prod, 'hyperdrive', 'binding')).toContain('HYPERDRIVE')
    expect(names(prod, 'kv_namespaces', 'binding')).toContain('RATE_LIMIT_KV')
    expect(get(prod, 'assets.binding')).toBe('ASSETS')
    expect(prod.compatibility_flags).toContain('nodejs_compat')
  })
})

// ---- must differ ------------------------------------------------------------------------

describe('wrangler parity: must differ', () => {
  it('staging name = production name + "-staging"', () => {
    expect(staging.name).toBe(`${prod.name}-staging`)
  })

  it('every account-scoped resource name in staging ends with -staging and differs from production', () => {
    for (const { section, scopedKey } of BINDING_SECTIONS) {
      if (!scopedKey) continue
      const p = names(prod, section, scopedKey)
      const s = names(staging, section, scopedKey)
      expect(s.length, `${section}: same number of entries`).toBe(p.length)
      for (const name of s) {
        expect(name, `${section}.${scopedKey}`).toMatch(/[-_]staging$/)
        expect(p, `${section}.${scopedKey} "${name}" is shared with production`).not.toContain(name)
      }
    }
  })

  it('resource ids differ between environments once provisioned', () => {
    // Skipped while placeholders remain (both files carry the same token shape but different text).
    for (const section of ['hyperdrive', 'kv_namespaces']) {
      const p = names(prod, section, 'id')
      const s = names(staging, section, 'id')
      for (const id of s) {
        if (PLACEHOLDER.test(id)) continue
        expect(p, `${section}.id "${id}" is shared with production`).not.toContain(id)
      }
    }
  })

  it('[vars].APP_URL differs', () => {
    expect(get(staging, 'vars.APP_URL')).not.toEqual(get(prod, 'vars.APP_URL'))
  })
})

// ---- provisioned ------------------------------------------------------------------------

describe.runIf(process.env.REQUIRE_PROVISIONED === '1')(
  'wrangler parity: provisioned (REQUIRE_PROVISIONED=1)',
  () => {
    it.each([
      ['wrangler.toml', prod],
      ['wrangler.staging.toml', staging],
    ])('%s contains no <PLACEHOLDER> values', (_file, doc) => {
      const left = strings(doc).filter(s => PLACEHOLDER.test(s))
      expect(
        left,
        'run `pnpm provision <env>` (apps/web/scripts/cf-provision.sh) and paste the ids'
      ).toEqual([])
    })

    it('hyperdrive and KV ids differ between environments', () => {
      for (const section of ['hyperdrive', 'kv_namespaces']) {
        const p = new Set(names(prod, section, 'id'))
        for (const id of names(staging, section, 'id'))
          expect(p.has(id), `${section}.id shared`).toBe(false)
      }
    })
  }
)

// ---- plugin resources (D31, Decision 12) --------------------------------------------------

/**
 * A plugin ships no toml — the two files are the host's, always — so everything it needs from the
 * platform is declared in its `plugin.json` and written into BOTH tomls by
 * `pnpm provision cloudflare <env>`. The rules above then apply to those blocks unchanged: same
 * `binding` name in both files, account-scoped names differing by the `-staging` / `_STAGING`
 * suffix, no `<PLACEHOLDER>` left at deploy time.
 *
 * The kit's one plugin (`example-feature`) declares NOTHING, so asserting only against what is
 * installed would be a test that passes because there is nothing to check. The rule is therefore a
 * pure function exercised against a FIXTURE plugin and fixture tomls built from the real files —
 * the same shape an app with a real plugin has — and then, separately, against the checkout.
 */
describe('wrangler parity: plugin resources', () => {
  const prodRaw = fs.readFileSync(path.join(WEB_DIR, 'wrangler.toml'), 'utf8')
  const stagingRaw = fs.readFileSync(path.join(WEB_DIR, 'wrangler.staging.toml'), 'utf8')
  const app = String(prod.name)

  const fixture = validatePluginManifest(
    {
      id: 'parity-fixture',
      bindings: [
        { type: 'kv', binding: 'PARITY_FIXTURE_CACHE', name: 'cache' },
        { type: 'queue', binding: 'PARITY_FIXTURE_QUEUE', name: 'jobs', consumer: true },
        { type: 'r2', binding: 'PARITY_FIXTURE_FILES', name: 'files' },
      ],
      crons: ['7 3 * * *'],
      apiPrefixes: ['/parity-fixture-hook'],
      vars: [
        { key: 'PARITY_FIXTURE_MAX_ITEMS', example: '50' },
        { key: 'PARITY_FIXTURE_SECRET', example: '', secret: true },
      ],
    },
    'apps/web/src/plugins/parity-fixture/plugin.json'
  )

  /** Exactly what `applyPluginDeclarations` in scripts/provision.ts writes, for one environment. */
  const provisionedText = (text: string, env: 'production' | 'staging', kvId: string) =>
    patchToml(text, {
      bindings: fixture.bindings.map(b => ({
        type: b.type,
        binding: b.binding,
        pluginId: fixture.id,
        ...(b.type === 'kv'
          ? { id: kvId }
          : { name: pluginResourceName(b.type, app, fixture.id, b.name, env) }),
        ...(b.consumer ? { consumer: true } : {}),
      })),
      crons: fixture.crons,
      workerFirstPrefixes: fixture.apiPrefixes,
      vars: fixture.vars.filter(v => !v.secret).map(v => ({ key: v.key, value: v.example ?? '' })),
    })

  const docs = (prodKv: string, stagingKv: string) => ({
    production: TOML.parse(provisionedText(prodRaw, 'production', prodKv)),
    staging: TOML.parse(provisionedText(stagingRaw, 'staging', stagingKv)),
  })

  // Empty documents, deliberately, rather than the repo’s tomls: these assertions are about what
  // the rule REPORTS, and they must not change meaning in a copy that has real plugins installed.
  const emptyDocs = { production: {}, staging: {} }

  it('unpatched tomls fail every rule `plugin add` is answerable for, in both environments', () => {
    // 3 bindings + 1 non-secret var, each in both files. The cron and the two run_worker_first
    // patterns are deliberately NOT here: `plugin add` never writes a toml (D31, decision 12), so a
    // plugin installed and not yet provisioned is a documented state the ordinary gate must pass.
    const issues = pluginParityIssues(app, [fixture], emptyDocs)
    expect(issues).toHaveLength(8)
    for (const env of ['production', 'staging'])
      for (const fragment of [
        '[[kv_namespaces]] has no binding "PARITY_FIXTURE_CACHE"',
        '[[queues.producers]] has no binding "PARITY_FIXTURE_QUEUE"',
        '[[r2_buckets]] has no binding "PARITY_FIXTURE_FILES"',
        '[vars] is missing "PARITY_FIXTURE_MAX_ITEMS"',
      ])
        expect(issues).toContainEqual(expect.stringContaining(`${env}: ${fragment}`))
    expect(issues.join('\n')).not.toContain('[triggers] crons')
    expect(issues.join('\n')).not.toContain('run_worker_first')
    // The secret var is NOT a [vars] key — it is a Worker secret (`provision secrets <env>`).
    expect(issues.join('\n')).not.toContain('PARITY_FIXTURE_SECRET')
  })

  it('under REQUIRE_PROVISIONED the crons and prefixes are demanded too', () => {
    // The deploy-time half: the 8 above, plus 1 cron and 2 run_worker_first patterns in both files.
    // (The consumer check is not among them: a missing producer stops at one message per binding
    // rather than piling a second on top of it.)
    const issues = pluginParityIssues(app, [fixture], emptyDocs, { requireProvisioned: true })
    expect(issues).toHaveLength(14)
    for (const env of ['production', 'staging'])
      for (const fragment of [
        '[triggers] crons is missing "7 3 * * *"',
        '[assets] run_worker_first is missing "/parity-fixture-hook"',
        '[assets] run_worker_first is missing "/parity-fixture-hook/*"',
      ])
        expect(issues).toContainEqual(expect.stringContaining(`${env}: ${fragment}`))
  })

  it('patched tomls satisfy every rule, in both environments', () => {
    expect(
      pluginParityIssues(
        app,
        [fixture],
        docs('<KV_PARITY_FIXTURE_CACHE_ID>', '<KV_PARITY_FIXTURE_CACHE_STAGING_ID>')
      )
    ).toEqual([])
  })

  it('the account-scoped names differ and carry the staging suffix', () => {
    const d = docs('<KV_PARITY_FIXTURE_CACHE_ID>', '<KV_PARITY_FIXTURE_CACHE_STAGING_ID>') as {
      production: Toml
      staging: Toml
    }
    for (const [section, key] of [
      ['queues.producers', 'queue'],
      ['r2_buckets', 'bucket_name'],
    ] as const) {
      const p = names(d.production, section, key)
      const s = names(d.staging, section, key)
      expect(s).toHaveLength(p.length)
      for (const name of s) {
        expect(name).toMatch(/-staging$/)
        expect(p).not.toContain(name)
      }
    }
    // The KV namespace has no name in the toml — its account-scoped name is created by
    // cf-provision.sh — so what the two files must not share is the ID.
    expect(get(d.production, 'kv_namespaces')).not.toEqual(get(d.staging, 'kv_namespaces'))
  })

  it('a placeholder id is allowed until REQUIRE_PROVISIONED, and refused then', () => {
    const withPlaceholders = docs(
      '<KV_PARITY_FIXTURE_CACHE_ID>',
      '<KV_PARITY_FIXTURE_CACHE_STAGING_ID>'
    )
    expect(pluginParityIssues(app, [fixture], withPlaceholders)).toEqual([])
    expect(
      pluginParityIssues(app, [fixture], withPlaceholders, { requireProvisioned: true })
    ).toEqual([
      'production: "PARITY_FIXTURE_CACHE" id is still <KV_PARITY_FIXTURE_CACHE_ID>',
      'staging: "PARITY_FIXTURE_CACHE" id is still <KV_PARITY_FIXTURE_CACHE_STAGING_ID>',
    ])
    expect(
      pluginParityIssues(app, [fixture], docs('a'.repeat(32), 'b'.repeat(32)), {
        requireProvisioned: true,
      })
    ).toEqual([])
  })

  // ---- and against what this checkout actually has ---------------------------------------

  it('every installed plugin is declared in both tomls', () => {
    expect(
      pluginParityIssues(
        app,
        installed,
        { production: prod, staging },
        {
          requireProvisioned: process.env.REQUIRE_PROVISIONED === '1',
        }
      )
    ).toEqual([])
  })

  it('every installed plugin prefix reaches the Worker first', () => {
    // `run_worker_first` is asserted equal to WORKER_FIRST_PATTERNS above, and that list is built
    // from the server barrel — so this checks the other half: that the MANIFEST and the barrel
    // agree about which prefixes the plugin owns.
    for (const plugin of installed)
      for (const prefix of plugin.apiPrefixes)
        expect(WORKER_FIRST_PATTERNS, `${plugin.id} declares ${prefix}`).toContain(prefix)
  })
})
