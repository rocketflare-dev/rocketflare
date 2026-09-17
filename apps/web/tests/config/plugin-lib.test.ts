/**
 * `scripts/lib/plugin-lib.mjs` and the `scripts/plugin.mjs` round trip (D31, Phase B).
 *
 * Almost everything here is a rule about a plugin THIS checkout does not have installed, so almost
 * everything is exercised against a fixture. The two that are not: the barrel writer is checked
 * against the five real barrel files (if it does not reproduce their bytes, every install leaves a
 * lint diff and the gate stops passing by construction), and the last block drives the script
 * itself — `export` into a temp directory, then `add` back with a fresh id, asserting that a plan
 * run writes NOTHING. The `config` project: no database, no network.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addBarrelLine,
  archiveSql,
  BARREL_KINDS,
  BARRELS,
  barrelExportName,
  barrelLines,
  buildPluginSurface,
  camelId,
  checkRequirements,
  classifyPluginFile,
  hasBarrelLine,
  isVendored,
  parsePluginRequirement,
  pluginIdProblem,
  pluginPlatformProblems,
  pluginRoots,
  removeBarrelLine,
  renderAddPlan,
  renderList,
  SUPPORTED_PLUGIN_BINDING_TYPES,
  surfaceDirectories,
  tupleEntries,
} from '../../../../scripts/lib/plugin-lib.mjs'
import type { Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'
import { SUPPORTED_PLUGIN_BINDING_TYPES as PROVISION_TYPES } from '../../scripts/provision/plugin-resources'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

describe('plugin ids', () => {
  it('accepts a namespace and rejects everything that is not one', () => {
    expect(pluginIdProblem('approvals')).toBeNull()
    expect(pluginIdProblem('example-feature')).toBeNull()
    expect(pluginIdProblem('Approvals')).toMatch(/must match/)
    expect(pluginIdProblem('9lives')).toMatch(/must match/)
    expect(pluginIdProblem('my_plugin')).toMatch(/must match/)
    expect(pluginIdProblem('')).toMatch(/required/)
  })

  it("refuses the kit's own name, because the rename would rewrite it", () => {
    expect(pluginIdProblem('rocketflare-extras')).toMatch(/kit's name/)
  })

  it('refuses a barrel filename', () => {
    for (const reserved of ['index', 'server', 'ui', 'schema', 'types']) {
      expect(pluginIdProblem(reserved)).toMatch(/barrel filename/)
    }
  })

  it('camelises an id into the stem of every export name', () => {
    expect(camelId('example-feature')).toBe('exampleFeature')
    expect(camelId('a-b-c')).toBe('aBC')
    expect(camelId('orders')).toBe('orders')
    expect(barrelExportName('server', 'example-feature')).toBe('exampleFeatureServer')
    expect(barrelExportName('schema', 'example-feature')).toBeNull()
  })
})

// The shape of a real barrel, reduced to what the writer touches — a doc comment that SHOWS the
// very line the writer matches (every real barrel does), the value imports, the type import and
// the tuple.
const fixtureBarrel = `/**
 *     import { approvalsServer } from './approvals'
 *     export const SERVER_PLUGINS = [approvalsServer] as const satisfies readonly AnyServerPlugin[]
 */
import type { AnyServerPlugin } from './types'

export const SERVER_PLUGINS = [] as const satisfies readonly AnyServerPlugin[]

export const serverPlugins: readonly AnyServerPlugin[] = SERVER_PLUGINS
`

describe('the barrel writer', () => {
  it('reads the code and not the doc comment that shows the same line', () => {
    // An unanchored regex finds `approvalsServer` in the header and reports a plugin nobody
    // installed — the bug this assertion exists for.
    expect(tupleEntries(fixtureBarrel, 'SERVER_PLUGINS')).toEqual([])
    expect(hasBarrelLine(fixtureBarrel, 'server', 'approvals')).toBe(false)
  })

  it('writes the import above the type import and the entry into the tuple', () => {
    const next = addBarrelLine(fixtureBarrel, 'server', 'orders')
    expect(next).toContain(
      "import { ordersServer } from './orders'\nimport type { AnyServerPlugin }"
    )
    expect(tupleEntries(next, 'SERVER_PLUGINS')).toEqual(['ordersServer'])
    expect(hasBarrelLine(next, 'server', 'orders')).toBe(true)
  })

  it('is idempotent, and sorts both the imports and the tuple', () => {
    const one = addBarrelLine(fixtureBarrel, 'server', 'orders')
    expect(addBarrelLine(one, 'server', 'orders')).toBe(one)
    const two = addBarrelLine(addBarrelLine(one, 'server', 'zebras'), 'server', 'approvals')
    const imports = two.split('\n').filter(l => l.startsWith('import { '))
    expect(imports).toEqual([
      "import { approvalsServer } from './approvals'",
      "import { ordersServer } from './orders'",
      "import { zebrasServer } from './zebras'",
    ])
    expect(tupleEntries(two, 'SERVER_PLUGINS')).toEqual([
      'approvalsServer',
      'ordersServer',
      'zebrasServer',
    ])
  })

  it('removes exactly what it added, for every barrel, against the REAL files', () => {
    // If a round trip is not byte-identical, `pnpm plugin add` produces a commit that fails lint.
    for (const kind of BARREL_KINDS) {
      const original = read(BARRELS[kind].file)
      expect(hasBarrelLine(original, kind, 'example-feature')).toBe(true)
      const without = removeBarrelLine(original, kind, 'example-feature')
      expect(hasBarrelLine(without, kind, 'example-feature')).toBe(false)
      expect(addBarrelLine(without, kind, 'example-feature')).toBe(original)
      expect(addBarrelLine(original, kind, 'example-feature')).toBe(original)
    }
  })

  it('writes one `export *` into the schema barrel and no tuple entry', () => {
    expect(barrelLines('schema', 'orders')).toEqual(["export * from './orders/db/schema'"])
    expect(barrelLines('server', 'orders')).toEqual([
      "import { ordersServer } from './orders'",
      'SERVER_PLUGINS entry: ordersServer',
    ])
  })

  it('points each barrel at the file whose presence means the plugin ships that half', () => {
    expect(BARRELS.shared.half('orders')).toBe('packages/shared/src/plugins/orders/index.ts')
    expect(BARRELS.ui.half('orders')).toBe('apps/web/src/plugins/orders/ui/index.ts')
    // The shared entry is imported as `.../orders/index` — the package's `./*` export maps to a
    // FILE, so dropping the `/index` does not resolve.
    expect(BARRELS.shared.specifier('orders')).toBe('./orders/index')
  })
})

describe('what a plugin may bring', () => {
  const roles = (p: string) => classifyPluginFile(p, 'orders').role

  it('copies the three trees and its docs at the identical path', () => {
    expect(classifyPluginFile('apps/web/src/plugins/orders/index.ts', 'orders')).toMatchObject({
      role: 'copy',
      target: 'apps/web/src/plugins/orders/index.ts',
    })
    expect(roles('packages/shared/src/plugins/orders/index.ts')).toBe('copy')
    expect(roles('apps/cli/src/plugins/orders/index.ts')).toBe('copy')
    expect(roles('docs/plugins/orders/README.md')).toBe('copy')
  })

  it("files its notes under the host's own corner for that plugin", () => {
    expect(classifyPluginFile('docs/upgrades/1.2.0.md', 'orders')).toMatchObject({
      role: 'note',
      target: 'docs/plugins/orders/upgrades/1.2.0.md',
    })
  })

  it('never copies a migration', () => {
    expect(roles('migrations/install/0001_backfill.sql')).toBe('fragment')
  })

  it("leaves the plugin repository's own tooling behind", () => {
    for (const p of ['.github/workflows/ci.yml', 'package.json', '.gitignore', 'pnpm-lock.yaml']) {
      expect(roles(p)).toBe('repo-only')
    }
    expect(roles('rocketflare-plugin.json')).toBe('meta')
    expect(roles('README.md')).toBe('meta')
  })

  it('REFUSES anything that would write outside the plugin roots', () => {
    for (const p of [
      'apps/web/src/api/index.ts',
      'apps/web/wrangler.toml',
      'apps/web/src/plugins/other/index.ts',
      'packages/shared/src/jobs.ts',
      'apps/web/migrations/0001_x.sql',
    ]) {
      expect(roles(p)).toBe('refused')
    }
  })

  it('names the four roots it owns', () => {
    expect(pluginRoots('orders')).toEqual([
      'apps/web/src/plugins/orders/',
      'packages/shared/src/plugins/orders/',
      'apps/cli/src/plugins/orders/',
      'docs/plugins/orders/',
    ])
  })
})

describe('requirements', () => {
  const base = { kitVersion: '0.5.0', presentSurfaces: ['feature-agents'], installedPlugins: [] }

  it('passes when everything asked for is there', () => {
    expect(
      checkRequirements({
        ...base,
        requires: { kit: '>=0.5.0 <1.0.0', surfaces: ['feature-agents'], plugins: [] },
      })
    ).toEqual([])
  })

  it('reports EVERY unmet requirement, not the first', () => {
    const problems = checkRequirements({
      ...base,
      requires: { kit: '>=0.6.0', surfaces: ['feature-analytics'], plugins: ['approvals'] },
    })
    expect(problems).toHaveLength(3)
    expect(problems[0]).toMatch(/kit 0\.5\.0 does not satisfy >=0\.6\.0/)
    expect(problems[1]).toMatch(/surface 'feature-analytics'/)
    expect(problems[2]).toMatch(/plugin 'approvals' is required and not installed/)
  })

  it('checks a required plugin VERSION, not just its presence', () => {
    const installedPlugins = [{ id: 'approvals', version: '1.2.0' }]
    expect(
      checkRequirements({ ...base, installedPlugins, requires: { plugins: ['approvals@^1.0.0'] } })
    ).toEqual([])
    expect(
      checkRequirements({ ...base, installedPlugins, requires: { plugins: ['approvals@^2.0.0'] } })
    ).toEqual(["plugin 'approvals' is 1.2.0, which does not satisfy ^2.0.0"])
  })

  it('splits a requirement into an id and a range', () => {
    expect(parsePluginRequirement('approvals')).toEqual({ id: 'approvals', range: null })
    expect(parsePluginRequirement('approvals@>=1.0.0 <2.0.0')).toEqual({
      id: 'approvals',
      range: '>=1.0.0 <2.0.0',
    })
  })

  it('does not hold a VENDORED plugin to a kit range', () => {
    // It ships inside the kit, so the same release cut both: the range describes the kit it came
    // with, and checking it makes the kit fail against itself for the whole of the release that
    // raises it.
    const requires = { kit: '>=0.5.0 <1.0.0' }
    expect(checkRequirements({ ...base, kitVersion: '0.4.0', requires })).toHaveLength(1)
    expect(checkRequirements({ ...base, kitVersion: '0.4.0', requires, vendored: true })).toEqual(
      []
    )
  })

  it("calls a plugin vendored only when it is the kit's own repo with no subdirectory", () => {
    const kit = 'https://github.com/rocketflare-dev/rocketflare.git'
    expect(isVendored({ repo: kit, subdir: '' }, kit)).toBe(true)
    expect(isVendored({ repo: kit }, kit)).toBe(true)
    expect(isVendored({ repo: kit, subdir: 'plugins/x' }, kit)).toBe(false)
    expect(isVendored({ repo: 'https://github.com/acme/p.git' }, kit)).toBe(false)
    expect(isVendored(null, kit)).toBe(false)
  })
})

const fixtureManifest = {
  id: 'orders',
  label: 'Orders',
  version: '1.1.0',
  repo: 'https://github.com/acme/rocketflare-plugin-orders.git',
  subdir: '',
  requires: { kit: '>=0.5.0 <1.0.0', surfaces: [], plugins: [] },
  dependencies: { 'apps/web': { 'date-fns': '^3.0.0' } },
  bindings: [{ type: 'kv', binding: 'ORDERS_KV', name: 'orders' }],
  crons: ['0 3 * * *'],
  apiPrefixes: ['/orders-webhook'],
  vars: [
    { key: 'ORDERS_MODE', example: '50' },
    { key: 'ORDERS_TOKEN', secret: true },
  ],
  workerExports: ['OrdersWorkflow'],
  schema: { tables: ['orders_orders', 'orders_lines'], rlsExcluded: [] },
}

describe('platform declarations', () => {
  it('knows the same binding types provisioning does', () => {
    // The list lives twice — `plugin-resources.ts` for `pnpm provision`, `plugin-lib.mjs` for the
    // plain-Node install script, which cannot import a `.ts` module. This assertion is what makes
    // the duplication safe: narrow or widen one and the suite fails.
    expect([...SUPPORTED_PLUGIN_BINDING_TYPES]).toEqual([...PROVISION_TYPES])
  })

  it('refuses a binding type provisioning cannot create, at INSTALL time', () => {
    // Otherwise it installs cleanly, deploys, and 503s on the first request that reads it off
    // `Cloudflare.Env` — days later, for somebody else.
    expect(pluginPlatformProblems(fixtureManifest)).toEqual([])
    const problems = pluginPlatformProblems({
      ...fixtureManifest,
      bindings: [
        { type: 'kv', binding: 'A', name: 'a' },
        { type: 'd1', binding: 'B', name: 'b' },
        { type: 'hyperdrive', binding: 'C', name: 'c' },
      ],
    })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/binding B declares type 'd1'/)
    expect(problems[1]).toMatch(/supported: kv, queue, r2/)
  })
})

describe('the surface an install records', () => {
  it('is built from the plugin manifest plus the three facts only the host knows', () => {
    const surface = buildPluginSurface(fixtureManifest, {
      repo: fixtureManifest.repo,
      subdir: '',
      commit: 'abc123',
      at: '2026-09-17',
    })
    expect(surface).toMatchObject({
      id: 'orders',
      kind: 'plugin',
      label: 'Orders',
      anchor: 'apps/web/src/plugins/orders/plugin.json',
      source: { repo: fixtureManifest.repo, subdir: '', version: '1.1.0', commit: 'abc123' },
      installedAt: '2026-09-17',
      history: [],
    })
    expect(surface.paths).toContain('apps/web/src/plugins/orders/**')
    expect(surface.registries).toContain('apps/web/src/plugins/server.ts')
  })

  it('turns the path globs back into the directories a remove deletes', () => {
    const surface = {
      paths: ['apps/web/src/plugins/orders/**', 'docs/plugins/orders/**'],
    } as Surface
    expect(surfaceDirectories(surface)).toEqual([
      'apps/web/src/plugins/orders',
      'docs/plugins/orders',
    ])
  })

  it('archives into another SCHEMA so the next db:generate sees nothing it knows', () => {
    const sql = archiveSql('orders', ['orders_orders'])
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS archive;')
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS archive."orders_orders" AS TABLE public."orders_orders";'
    )
    // `rls-coverage.test.ts` scopes every catalog query to `public`, so the copies are invisible
    // to it — which is the whole reason for a second schema rather than a rename in place.
    expect(read('apps/web/tests/api/rls-coverage.test.ts')).toContain("table_schema = 'public'")
  })

  it('lists installed plugins, marking the ones that live in the sidecar', () => {
    const surface = buildPluginSurface(fixtureManifest, {
      repo: fixtureManifest.repo,
      commit: 'abc123',
      at: '2026-09-17',
    })
    expect(renderList([surface], { sidecarIds: ['orders'] })[0]).toMatch(
      /orders.*1\.1\.0.*\(local\)/
    )
    expect(renderList([])).toEqual(['No plugins installed.'])
  })
})

describe('the install plan', () => {
  const plan = {
    manifest: fixtureManifest,
    source: { repo: fixtureManifest.repo, subdir: '', ref: '1.1.0', commit: 'abc123def4567' },
    host: {
      label: 'Acme Logistics (acme)',
      kitVersion: '0.5.0',
      recordsIn: '.rocketflare.json',
      translated: true,
    },
    vendored: false,
    problems: [] as string[],
    files: [
      {
        path: 'apps/web/src/plugins/orders/index.ts',
        role: 'copy' as const,
        root: 'apps/web/src/plugins/orders/',
      },
      { path: 'docs/upgrades/1.1.0.md', role: 'note' as const },
      { path: 'migrations/install/0001_seed.sql', role: 'fragment' as const },
    ],
    byRoot: { 'apps/web/src/plugins/orders/': 1 },
    barrels: ['shared', 'server', 'ui', 'schema', 'cli'] as const,
    verify: 'The Orders page lists one order.',
  }

  it('names every thing the script will NOT do for you', () => {
    const text = renderAddPlan({ ...plan, barrels: [...plan.barrels] }).join('\n')
    // The schema migration is the host's, always.
    expect(text).toContain('pnpm db:generate --name plugin-orders-1.1.0')
    expect(text).toContain('CREATE TABLE orders_orders, orders_lines')
    // The platform half is one command per environment (decision 12), not a hand edit of two
    // tomls — `pnpm provision cloudflare <env>` reads the same declarations off the surface.
    expect(text).toContain('pnpm provision cloudflare <env>')
    expect(text).toContain('kv binding ORDERS_KV')
    expect(text).toContain('cron "0 3 * * *"')
    expect(text).toContain('route prefix /orders-webhook')
    expect(text).toContain('[vars] ORDERS_MODE')
    // A secret is its own step, because it must never reach a toml at all.
    expect(text).toContain('add `ORDERS_TOKEN=` to apps/web/.dev.vars.example')
    expect(text).toContain('pnpm provision secrets <env>')
    expect(text).not.toMatch(/\[vars\] ORDERS_TOKEN/)
    expect(text).toContain('export { OrdersWorkflow }')
    expect(text).toContain('paste migrations/install/0001_seed.sql')
    expect(text).toContain('pnpm lint && pnpm typecheck && pnpm test && pnpm build')
  })

  it('shows where it came from, where it is recorded, and whether it was translated', () => {
    const text = renderAddPlan({ ...plan, barrels: [...plan.barrels] }).join('\n')
    expect(text).toContain('orders@1.1.0 — Orders')
    expect(text).toContain('@ 1.1.0 (abc123def456)')
    expect(text).toContain('records into .rocketflare.json')
    expect(text).toContain("translated into Acme Logistics (acme)'s vocabulary")
    expect(text).toContain("Verify (from the plugin's own note)")
    expect(text).toContain('The Orders page lists one order.')
    for (const kind of BARREL_KINDS) expect(text).toContain(BARRELS[kind].file)
  })

  it('shows an unmet requirement as a ✖ beside the others', () => {
    const text = renderAddPlan({
      ...plan,
      barrels: [...plan.barrels],
      problems: ['kit 0.4.0 does not satisfy >=0.5.0 <1.0.0'],
    }).join('\n')
    expect(text).toContain('✖ kit 0.4.0 does not satisfy')
    expect(text).not.toContain('✔ kit')
  })

  it('says a vendored plugin is not held to the range', () => {
    const text = renderAddPlan({ ...plan, barrels: [...plan.barrels], vendored: true }).join('\n')
    expect(text).toContain('vendored — shipped with the kit')
  })
})

// ---------------------------------------------------------------- the script itself

const plugin = (args: string[], cwd = REPO_ROOT) => {
  try {
    return {
      status: 0,
      out: execFileSync('node', [path.join(REPO_ROOT, 'scripts/plugin.mjs'), ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string }
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('scripts/plugin.mjs, end to end', () => {
  it('exports a plugin, adds it back under a fresh id, and writes nothing without --apply', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-plugin-'))
    try {
      expect(plugin(['export', 'example-feature', dir]).status).toBe(0)
      expect(existsSync(path.join(dir, 'rocketflare-plugin.json'))).toBe(true)
      expect(existsSync(path.join(dir, 'apps/web/src/plugins/example-feature/plugin.json'))).toBe(
        true
      )

      // Re-badge the export as a plugin this checkout does not have: same tree, a new id, its own
      // repository (so it is not vendored) and a kit range this kit satisfies. Without that it is
      // simply the installed plugin, and `add` correctly refuses with exit 7.
      for (const base of [
        'apps/web/src/plugins',
        'packages/shared/src/plugins',
        'apps/cli/src/plugins',
      ]) {
        const from = path.join(dir, base, 'example-feature')
        if (existsSync(from)) {
          mkdirSync(path.dirname(path.join(dir, base, 'smoke-plugin')), { recursive: true })
          renameSync(from, path.join(dir, base, 'smoke-plugin'))
        }
      }
      const manifestFile = path.join(dir, 'rocketflare-plugin.json')
      const rebadged = JSON.parse(
        readFileSync(manifestFile, 'utf8').replaceAll('example-feature', 'smoke-plugin')
      )
      rebadged.repo = 'https://github.com/acme/rocketflare-plugin-smoke.git'
      rebadged.requires.kit = '>=0.1.0'
      writeFileSync(manifestFile, `${JSON.stringify(rebadged, null, 2)}\n`)

      const before = BARREL_KINDS.map(k => read(BARRELS[k].file))
      const sidecarBefore = existsSync(path.join(REPO_ROOT, '.rocketflare.local.json'))

      const plan = plugin(['add', dir, '--local'])
      expect(plan.status).toBe(0)
      expect(plan.out).toContain('Plugin      smoke-plugin@')
      expect(plan.out).toContain('Barrel lines')
      expect(plan.out).toContain('Nothing written.')

      // Nothing written means nothing written.
      expect(BARREL_KINDS.map(k => read(BARRELS[k].file))).toEqual(before)
      expect(existsSync(path.join(REPO_ROOT, '.rocketflare.local.json'))).toBe(sidecarBefore)
      expect(existsSync(path.join(REPO_ROOT, 'apps/web/src/plugins/smoke-plugin'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to add a plugin that is already installed, by id', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-plugin-'))
    try {
      expect(plugin(['export', 'example-feature', dir]).status).toBe(0)
      const again = plugin(['add', dir, '--local'])
      expect(again.status).toBe(7)
      expect(again.out).toMatch(/already installed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a source with no plugin manifest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-plugin-'))
    try {
      const r = plugin(['add', dir])
      expect(r.status).toBe(5)
      expect(r.out).toContain('rocketflare-plugin.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks this checkout, and skips the vendored plugin’s kit range while doing it', () => {
    const r = plugin(['check'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('example-feature')
    expect(r.out).toContain('vendored')
  })

  it('defers a vendored upgrade to `pnpm kit:upgrade`', () => {
    const r = plugin(['upgrade', 'example-feature'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('kit:upgrade')
  })

  it('exits 2 on usage and 1 on an unknown plugin', () => {
    expect(plugin([]).status).toBe(2)
    expect(plugin(['add']).status).toBe(2)
    expect(plugin(['remove', 'nope']).status).toBe(1)
  })
})
