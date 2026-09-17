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
  MANIFEST_FILE,
  pluginSurfaces,
  readManifest,
  SIDECAR_FILE,
} from '../../../../scripts/lib/manifest.mjs'
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
  PLUGIN_MANIFEST_FILE,
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
  unsupportedForKit,
} from '../../../../scripts/lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, KIT } from '../../../../scripts/lib/rename-lib.mjs'
import type { Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'
import { SUPPORTED_PLUGIN_BINDING_TYPES as PROVISION_TYPES } from '../../scripts/provision/plugin-resources'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/**
 * Everything below drives the script against THIS checkout, so its subject is whatever plugin is
 * installed here rather than the kit's reference one by name. An app is expected to delete
 * `example-feature` — that is what it is for — and these tests travel into every app with the rest
 * of the kit's suite, so naming it would turn "I uninstalled the example" into a red gate.
 */
const installedHere = pluginSurfaces(readManifest().manifest)
const subject = installedHere[0]?.id ?? null
const kitRepo = readManifest().manifest?.kit.repo ?? ''
const vendoredHere = installedHere.find(s => isVendored(s.source, kitRepo))?.id ?? null

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
    expect(pluginIdProblem(`${KIT.slug}-extras`)).toMatch(/kit's name/)
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

  it.skipIf(!subject)(
    'removes exactly what it added, for every barrel, against the REAL files',
    () => {
      // If a round trip is not byte-identical, `pnpm plugin add` produces a commit that fails lint.
      for (const kind of BARREL_KINDS) {
        const original = read(BARRELS[kind].file)
        expect(hasBarrelLine(original, kind, subject as string)).toBe(true)
        const without = removeBarrelLine(original, kind, subject as string)
        expect(hasBarrelLine(without, kind, subject as string)).toBe(false)
        expect(addBarrelLine(without, kind, subject as string)).toBe(original)
        expect(addBarrelLine(original, kind, subject as string)).toBe(original)
      }
    }
  )

  it('writes one `export *` into the schema barrel and no tuple entry', () => {
    expect(barrelLines('schema', 'orders')).toEqual(["export * from './orders/db/schema'"])
    expect(barrelLines('server', 'orders')).toEqual([
      "import { ordersServer } from './orders'",
      'SERVER_PLUGINS entry: ordersServer',
    ])
  })

  /**
   * A TypeScript file with no top-level import or export is a SCRIPT, not a module. The schema
   * barrel is the one of the five that declares no const, so removing the last plugin left it as a
   * comment and `db/schema/index.ts`'s `export * from '../plugins/schema'` became TS2306 — the
   * whole app stopped typechecking the moment somebody uninstalled the reference plugin, which is
   * the one thing that plugin exists for.
   */
  it('leaves the schema barrel a MODULE when the last plugin goes', () => {
    const real = read(BARRELS.schema.file)
    const bare = installedHere.reduce((text, s) => removeBarrelLine(text, 'schema', s.id), real)
    expect(bare).not.toMatch(/^export \* from/m)
    expect(bare).toContain('export {}')
    // …and the marker gives way to the first plugin that arrives, byte for byte.
    expect(addBarrelLine(bare, 'schema', 'orders')).not.toContain('export {}')
    if (subject) expect(addBarrelLine(bare, 'schema', subject)).toBe(real)
  })

  it('points each barrel at the file whose presence means the plugin ships that half', () => {
    expect(BARRELS.shared.half('orders')).toBe('packages/shared/src/plugins/orders/index.ts')
    expect(BARRELS.ui.half('orders')).toBe('apps/web/src/plugins/orders/ui/index.ts')
    // The shared entry is imported as `.../orders/index` — the package's `./*` export maps to a
    // FILE, so dropping the `/index` does not resolve.
    expect(BARRELS.shared.specifier('orders')).toBe('./orders/index')
  })
})

/**
 * Why `scripts/plugin.mjs` runs biome over the files it just wrote.
 *
 * A plugin is authored in the KIT's vocabulary and translated on the way in, and translation moves
 * a package scope in the alphabet: `@heroicons/react` sorts AFTER `@acme/shared` and BEFORE
 * `@rocketflare/shared`. So a file that is correctly sorted in the kit arrives unsorted in an app
 * whose scope sorts the other way, and `pnpm lint` — the first line of the gate the install plan
 * tells you to run next — fails on a file the tool wrote. `rename.mjs` has the same problem and
 * solves it the same way.
 */
describe('translation and import order', () => {
  it('moves a scope past its neighbours in the sort', () => {
    const kitOrder = [`@heroicons/react/24/outline`, `@${KIT.slug}/shared/plugins/x/index`]
    expect([...kitOrder].sort()).toEqual(kitOrder)
    const appOrder = kitOrder.map(s => applyReplacements(s, deriveNames('acme', 'Acme')).text)
    // The same two imports, in the same file, now in the WRONG order for this app.
    expect([...appOrder].sort()).not.toEqual(appOrder)
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
    expect(roles(PLUGIN_MANIFEST_FILE)).toBe('meta')
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

  /**
   * `plugin check` and `kit:upgrade` have to answer this identically, and once did not: check
   * printed "vendored — requires.kit is not checked" and exited 0 while `kit:upgrade`, in the same
   * checkout and over the same range, refused with exit 6. Every copy of the kit would have been
   * stopped from upgrading by the plugin the kit itself ships.
   */
  it('exempts a vendored plugin from the kit range for `kit:upgrade` too', () => {
    const kitRepo = 'https://github.com/rocketflare-dev/rocketflare.git'
    const vendored = {
      id: 'example',
      source: { repo: kitRepo, subdir: '' },
      requires: { kit: '>=9.0.0' },
    }
    const third = {
      id: 'orders',
      source: { repo: 'https://github.com/acme/p.git' },
      requires: { kit: '>=9.0.0' },
    }
    expect(
      unsupportedForKit([vendored, third], { kitRepo, version: '0.4.0' }).map(p => p.id)
    ).toEqual(['orders'])
    // In range, nobody is unsupported; with no target version there is nothing to judge against.
    expect(unsupportedForKit([third], { kitRepo, version: '9.1.0' })).toEqual([])
    expect(unsupportedForKit([third], { kitRepo, version: null })).toEqual([])
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
      recordsIn: MANIFEST_FILE,
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
    expect(text).toContain(`records into ${MANIFEST_FILE}`)
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
  it.skipIf(!subject)(
    'exports a plugin, adds it back under a fresh id, and writes nothing without --apply',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'rf-plugin-'))
      try {
        expect(plugin(['export', subject as string, dir]).status).toBe(0)
        expect(existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))).toBe(true)
        expect(existsSync(path.join(dir, `apps/web/src/plugins/${subject}/plugin.json`))).toBe(true)

        // Re-badge the export as a plugin this checkout does not have: same tree, a new id, its own
        // repository (so it is not vendored) and a kit range this kit satisfies. Without that it is
        // simply the installed plugin, and `add` correctly refuses with exit 7.
        for (const base of [
          'apps/web/src/plugins',
          'packages/shared/src/plugins',
          'apps/cli/src/plugins',
        ]) {
          const from = path.join(dir, base, subject as string)
          if (existsSync(from)) {
            mkdirSync(path.dirname(path.join(dir, base, 'smoke-plugin')), { recursive: true })
            renameSync(from, path.join(dir, base, 'smoke-plugin'))
          }
        }
        const manifestFile = path.join(dir, PLUGIN_MANIFEST_FILE)
        const rebadged = JSON.parse(
          readFileSync(manifestFile, 'utf8').replaceAll(subject as string, 'smoke-plugin')
        )
        rebadged.repo = 'https://github.com/acme/rocketflare-plugin-smoke.git'
        rebadged.requires.kit = '>=0.1.0'
        writeFileSync(manifestFile, `${JSON.stringify(rebadged, null, 2)}\n`)

        const before = BARREL_KINDS.map(k => read(BARRELS[k].file))
        const sidecarBefore = existsSync(path.join(REPO_ROOT, SIDECAR_FILE))

        const plan = plugin(['add', dir, '--local'])
        expect(plan.status).toBe(0)
        expect(plan.out).toContain('Plugin      smoke-plugin@')
        expect(plan.out).toContain('Barrel lines')
        expect(plan.out).toContain('Nothing written.')

        // Nothing written means nothing written.
        expect(BARREL_KINDS.map(k => read(BARRELS[k].file))).toEqual(before)
        expect(existsSync(path.join(REPO_ROOT, SIDECAR_FILE))).toBe(sidecarBefore)
        expect(existsSync(path.join(REPO_ROOT, 'apps/web/src/plugins/smoke-plugin'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!subject)('refuses to add a plugin that is already installed, by id', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-plugin-'))
    try {
      expect(plugin(['export', subject as string, dir]).status).toBe(0)
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
      expect(r.out).toContain(PLUGIN_MANIFEST_FILE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!vendoredHere)(
    'checks this checkout, and skips the vendored plugin’s kit range while doing it',
    () => {
      const r = plugin(['check'])
      expect(r.status).toBe(0)
      expect(r.out).toContain(vendoredHere)
      expect(r.out).toContain('vendored')
    }
  )

  it.skipIf(!vendoredHere)('defers a vendored upgrade to `pnpm kit:upgrade`', () => {
    const r = plugin(['upgrade', vendoredHere as string])
    expect(r.status).toBe(0)
    expect(r.out).toContain('kit:upgrade')
  })

  it('exits 2 on usage and 1 on an unknown plugin', () => {
    expect(plugin([]).status).toBe(2)
    expect(plugin(['add']).status).toBe(2)
    expect(plugin(['remove', 'nope']).status).toBe(1)
  })
})
