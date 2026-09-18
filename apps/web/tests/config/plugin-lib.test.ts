/**
 * `scripts/lib/plugin-lib.mjs` and the `scripts/plugin.mjs` round trip (D31, Phase B).
 *
 * Almost everything here is a rule about a plugin THIS checkout does not have installed, so almost
 * everything is exercised against a fixture. The two that are not: the barrel writer is checked
 * against the six real barrel files (if it does not reproduce their bytes, every install leaves a
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
  addPlanJson,
  applyCoreEdits,
  archiveSql,
  auditSeverity,
  BARREL_KINDS,
  BARRELS,
  barrelExportName,
  barrelLines,
  buildPluginSurface,
  camelId,
  checkRequirements,
  classifyPluginFile,
  coreEditsByFile,
  declaresProperty,
  dependencyClashes,
  describeClash,
  hasBarrelLine,
  isolationEvidence,
  isVendored,
  jsonKeyLine,
  missingDependencies,
  nextPluginMigrationTag,
  PLUGIN_MANIFEST_FILE,
  parsePluginRequirement,
  planSteps,
  pluginIdProblem,
  pluginManifestProblems,
  pluginMigrationTag,
  pluginPlatformProblems,
  pluginRoots,
  removeBarrelLine,
  removeSteps,
  renderAddPlan,
  renderDiagnostic,
  renderList,
  renderSteps,
  resolveSubdir,
  revertCoreEdits,
  STEP_KINDS,
  SUPPORTED_PLUGIN_BINDING_TYPES,
  surfaceDirectories,
  tupleEntries,
  unsupportedForKit,
  workerExportNames,
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
    for (const reserved of ['index', 'server', 'ui', 'schema', 'types', 'worker-exports']) {
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
      // Only the barrels whose HALF the subject ships: an install writes a line per half that
      // arrived, so a plugin with no Durable Object has no line in the worker barrel and a plugin
      // with no CLI command has none in the CLI one. Asserting otherwise tests the fixture, not
      // the writer.
      for (const kind of BARREL_KINDS) {
        if (!existsSync(path.join(REPO_ROOT, BARRELS[kind].half(subject as string)))) continue
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
    // Putting every installed plugin back has to reproduce the file exactly — all of them, not
    // just the first: the moment a second plugin was installed (D31, Phase C) a one-id round trip
    // stopped being the same file, and a test that only ever saw one would not have noticed.
    const rebuilt = installedHere.reduce((text, s) => addBarrelLine(text, 'schema', s.id), bare)
    if (installedHere.length > 0) expect(rebuilt).toBe(real)
  })

  /**
   * The sixth barrel, and the reason it exists rather than a `coreEdits` entry or a printed line.
   *
   * Cloudflare resolves a binding's `class_name` against the named exports of the Worker's ENTRY
   * module, so a plugin shipping a Durable Object or a Workflow needs a line in `src/worker.ts`.
   * That used to be a numbered step in the install plan, which an unattended install (CI applies
   * nothing it reads) simply did not perform: the tree built, deployed, and every request that
   * reached the binding failed. `coreEdits` would work and is the wrong shape — it would have every
   * class-shipping plugin mutating `worker.ts`, which is what a barrel exists to prevent.
   */
  it('writes one `export *` into the worker barrel, and worker.ts re-exports it permanently', () => {
    expect(barrelLines('worker', 'orders')).toEqual(["export * from './orders/worker-exports'"])
    expect(BARRELS.worker.half('orders')).toBe('apps/web/src/plugins/orders/worker-exports.ts')
    // The one line in the entry module. It names no plugin, so no install ever edits this file.
    expect(read('apps/web/src/worker.ts')).toContain("export * from './plugins/worker-exports'")
  })

  /**
   * Driven with a FIXTURE id rather than what is installed, because no plugin here ships a class —
   * and that is the state this has to hold in: `worker.ts` does `export *` from this barrel, and a
   * TypeScript file with no top-level export is a SCRIPT rather than a module (TS2306 at the
   * importer), so a bare kit must still carry the marker. The schema barrel's equivalent test can
   * use the installed set because `example-feature` does ship tables.
   */
  it('keeps the worker barrel a MODULE with no plugin in it, and round-trips byte for byte', () => {
    const real = read(BARRELS.worker.file)
    expect(real).toContain('export {}')
    const added = addBarrelLine(real, 'worker', 'orders')
    expect(added).toContain("export * from './orders/worker-exports'")
    expect(added).not.toContain('export {}')
    expect(removeBarrelLine(added, 'worker', 'orders')).toBe(real)
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
describe('core edits a plugin declares', () => {
  const VITE = `export default defineConfig({
  server: {
    proxy: {
      '/api': proxyTo(),
      '/ws': proxyTo('ws://localhost:3001', { ws: true }),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
})
`
  const edits = [
    {
      file: 'apps/web/vite.config.ts',
      after: "'/ws': proxyTo(",
      lines: ["'/cubejs-api': proxyTo(),", "'/mcp': proxyTo(),"],
    },
    {
      file: 'apps/web/vite.config.ts',
      after: "'@': path.resolve(",
      lines: [
        "'@nivo/heatmap': path.resolve(__dirname, './src/plugins/analytics/ui/lib/nivo-heatmap.tsx'),",
      ],
    },
  ]

  it('inserts each line after its anchor, at the anchor indentation', () => {
    const out = applyCoreEdits(VITE, edits)
    expect(out).toContain("      '/cubejs-api': proxyTo(),")
    expect(out).toContain("      '/mcp': proxyTo(),")
    expect(out).toContain("      '@nivo/heatmap': path.resolve(")
    // the anchor line itself is untouched and still precedes what was inserted
    expect(out.indexOf("'/ws': proxyTo(")).toBeLessThan(out.indexOf("'/cubejs-api'"))
  })

  it('is idempotent — applying twice changes nothing', () => {
    const once = applyCoreEdits(VITE, edits)
    expect(applyCoreEdits(once, edits)).toBe(once)
  })

  it('reverts to the original bytes — add then remove is a round trip', () => {
    expect(revertCoreEdits(applyCoreEdits(VITE, edits), edits)).toBe(VITE)
  })

  it('throws, naming the file and the anchor, when the anchor has moved', () => {
    // Silently skipping a missing anchor is the whole failure this replaces: the build breaks
    // somewhere else entirely, with nothing pointing back at the plugin.
    expect(() =>
      applyCoreEdits(VITE, [
        { file: 'apps/web/vite.config.ts', after: 'noSuchAnchor', lines: ['x'] },
      ])
    ).toThrow(/apps\/web\/vite\.config\.ts.*noSuchAnchor/s)
  })

  it("groups a manifest's edits by the file they touch", () => {
    const byFile = coreEditsByFile({ coreEdits: edits })
    expect([...byFile.keys()]).toEqual(['apps/web/vite.config.ts'])
    expect(byFile.get('apps/web/vite.config.ts')).toHaveLength(2)
  })

  it('is empty for a manifest that declares none', () => {
    expect(coreEditsByFile({}).size).toBe(0)
    expect(applyCoreEdits(VITE, [])).toBe(VITE)
  })
})

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
    for (const p of [
      '.github/workflows/ci.yml',
      'package.json',
      '.gitignore',
      'pnpm-lock.yaml',
      // A plugin repo carries the kit's release script and the libs it imports — there is no
      // `pnpm plugin:release`, so cutting a release means having them. They belong to that
      // repository and never to a host, where `scripts/` is the kit's own.
      'scripts/release.mjs',
      'scripts/lib/upgrade-lib.mjs',
    ]) {
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

  it('refuses a binding type provisioning cannot write, at INSTALL time', () => {
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
    expect(problems[1]).toMatch(/supported: kv, queue, r2, workflow, durable_object/)
  })

  /**
   * `workflow` and `durable_object` graduated when the sixth barrel landed, and only then: a
   * `class_name` resolves against the named exports of `src/worker.ts`, so before
   * `plugins/worker-exports.ts` made a plugin's class reachable there, either block would have
   * named a class nothing exported — and `wrangler deploy` refuses the whole SCRIPT for that,
   * which is worse than refusing the install. `d1` and `vectorize` still have no such mechanism.
   */
  it('accepts a workflow and a durable object, and demands what each block cannot be written without', () => {
    expect(
      pluginPlatformProblems({
        ...fixtureManifest,
        bindings: [
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
        ],
      })
    ).toEqual([])

    // No class → a block pointing at nothing.
    expect(
      pluginPlatformProblems({
        ...fixtureManifest,
        bindings: [{ type: 'workflow', binding: 'W', name: 'w' }],
      })
    ).toContainEqual(expect.stringContaining('declares no className'))
    // A workflow name is ACCOUNT-scoped, so it is the half that must differ between environments.
    expect(
      pluginPlatformProblems({
        ...fixtureManifest,
        bindings: [{ type: 'workflow', binding: 'W', className: 'W' }],
      })
    ).toContainEqual(expect.stringContaining('declares no name'))
    // Storage is REQUIRED rather than defaulted: a namespace cannot be migrated between the two,
    // so guessing it is not something anybody can undo.
    expect(
      pluginPlatformProblems({
        ...fixtureManifest,
        bindings: [{ type: 'durable_object', binding: 'H', className: 'H' }],
      })
    ).toContainEqual(expect.stringContaining('storage'))
    // …and it is meaningless anywhere else.
    expect(
      pluginPlatformProblems({
        ...fixtureManifest,
        bindings: [{ type: 'kv', binding: 'K', name: 'k', storage: 'sqlite' }],
      })
    ).toContainEqual(expect.stringContaining('only a durable_object has'))
  })

  /**
   * A DO migration tag is an identity Cloudflare has already acted on — the same thing a SQL
   * migration's name is — so the numbering is append-only and the helper never reuses one.
   */
  it('numbers a plugin migration tag append-only, per plugin', () => {
    expect(pluginMigrationTag('orders')).toBe('plugin-orders-v1')
    expect(nextPluginMigrationTag([], 'orders')).toBe('plugin-orders-v1')
    expect(nextPluginMigrationTag(['v1', 'plugin-orders-v1'], 'orders')).toBe('plugin-orders-v2')
    // Gaps are never filled: the highest wins, so a tag can only ever move forward.
    expect(nextPluginMigrationTag(['plugin-orders-v1', 'plugin-orders-v7'], 'orders')).toBe(
      'plugin-orders-v8'
    )
    // Another plugin's tags are not this plugin's sequence.
    expect(nextPluginMigrationTag(['plugin-billing-v9'], 'orders')).toBe('plugin-orders-v1')
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
    // Always, whether the plugin declared it or not: `add` copies the plugin's release notes to
    // `docs/plugins/<id>/upgrades/`, so a surface that did not name them would leave the host with
    // files no surface classifies (`kit-manifest.test.ts`) and a `remove` that leaves them behind.
    expect(surface.paths).toContain('docs/plugins/orders/**')
    expect(surface.registries).toContain('apps/web/src/plugins/server.ts')
    expect(surface.requires?.kit).toBe('>=0.5.0 <1.0.0')
  })

  it('records an UNDECLARED kit range as null, never as "*"', () => {
    // `'*'` reads as "checked, and anything is allowed", and it put such a plugin beyond every gate
    // there is: `checkRequirements`, `unsupportedForKit` and `kit:upgrade` all skip a falsy range,
    // so a plugin that declared nothing was carried across a major kit version without a word.
    // Null is the same silence — but `plugin check` and the install plan both say it out loud.
    const silent = { id: 'orders', label: 'Orders', version: '1.1.0', repo: 'https://x.test/o.git' }
    const surface = buildPluginSurface(silent, { repo: silent.repo, at: '2026-09-17' })
    expect(surface.requires?.kit).toBeNull()
    expect(surface.requires?.surfaces).toEqual([])
    expect(surface.requires?.plugins).toEqual([])
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
    barrels: ['shared', 'server', 'ui', 'schema', 'worker', 'cli'] as const,
    verify: 'The Orders page lists one order.',
  }

  it('names every thing the script will NOT do for you', () => {
    const text = renderAddPlan({ ...plan, barrels: [...plan.barrels] }).join('\n')
    // The schema migration is the host's, always.
    expect(text).toContain('pnpm db:generate --name plugin-orders-1.1.0')
    expect(text).toContain('CREATE TABLE orders_orders, orders_lines')
    // The platform half is one command per environment (decision 12), not a hand edit of two
    // tomls — `pnpm provision cloudflare <env>` reads the same declarations off the surface.
    expect(text).toContain('pnpm provision cloudflare staging')
    expect(text).toContain('kv binding ORDERS_KV')
    expect(text).toContain('cron "0 3 * * *"')
    expect(text).toContain('route prefix /orders-webhook')
    expect(text).toContain('[vars] ORDERS_MODE')
    // A secret is TWO steps, because the key and the value are different kinds of work.
    expect(text).toContain('add `ORDERS_TOKEN=` to apps/web/.dev.vars.example')
    expect(text).toContain('pnpm provision secrets <env>')
    expect(text).not.toMatch(/\[vars\] ORDERS_TOKEN/)
    // NOT a step any more: `workerExports` became the sixth barrel, so the class reaches
    // `src/worker.ts` through a line `plugin add` writes rather than one a person is told to write.
    expect(text).not.toContain('apps/web/src/worker.ts')
    expect(text).toContain('apps/web/src/plugins/worker-exports.ts')
    expect(text).toContain('paste migrations/install/0001_seed.sql')
    expect(text).toContain('pnpm lint && pnpm typecheck && pnpm test && pnpm build')
    // "by hand" is retired: every step says which KIND it is, and carries its own assertion.
    expect(text).not.toContain('by hand')
    expect(text).toContain('Human steps')
    expect(text).toContain('Agent steps')
    expect(text).toContain('assert')
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

  it('WARNS rather than ticking when the plugin declares no kit range', () => {
    // The plan is what a person reads before saying yes, and "no version will ever be checked
    // against this" is not the same sentence as "✔ kit 0.5.0 satisfies *".
    const silent = { id: 'orders', label: 'Orders', version: '1.1.0', repo: 'https://x.test/o.git' }
    const text = renderAddPlan({
      ...plan,
      manifest: silent,
      barrels: [...plan.barrels],
    }).join('\n')
    expect(text).toContain('declares no requires.kit')
    expect(text).not.toContain('✔ kit')
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

/**
 * The step taxonomy (D31). "By hand" is retired as a phrase because it answers neither question
 * that matters to whatever performs the step — and installs are performed by AGENTS as often as by
 * people, for whom prose is not a control.
 *
 * The two assertions that carry weight here are what is ABSENT and what is HUMAN. Absent, because a
 * step becomes declarative by being MECHANISED (Parts 1 and 2) rather than by being reworded; and
 * human, because that list must only ever hold things that are not automatable in principle.
 */
describe('the step taxonomy', () => {
  const classy = {
    ...fixtureManifest,
    bindings: [
      { type: 'kv', binding: 'ORDERS_KV', name: 'orders' },
      { type: 'durable_object', binding: 'ORDERS_HUB', className: 'OrdersHub', storage: 'sqlite' },
    ],
  }

  it('has exactly three kinds, and only two of them ever reach a plan', () => {
    expect([...STEP_KINDS]).toEqual(['declarative', 'agent', 'human'])
    const kinds = new Set(planSteps(classy).map(s => s.kind))
    expect(kinds.has('declarative')).toBe(false)
  })

  it('drops every step Parts 1 and 2 mechanised', () => {
    const steps = planSteps(classy)
    const text = JSON.stringify(steps)
    // The barrel lines, the sixth included: `plugin add` writes them.
    expect(text).not.toContain('worker.ts')
    expect(text).not.toContain('barrel')
    // The toml blocks, the cron, the prefixes and the DO migration tag: `provision cloudflare`
    // writes them. What survives is the one INVOCATION, which somebody still has to run.
    expect(text).not.toContain('[[durable_objects')
    expect(text).not.toContain('[[migrations]]')
    expect(steps.filter(s => s.id === 'provision')).toHaveLength(1)
  })

  it('gives every step a command, an observable result and the assertion that proves it', () => {
    const every = [
      ...planSteps(classy, { fragments: ['migrations/0001.sql'] }),
      ...removeSteps(classy),
    ]
    for (const s of every) {
      expect(s.kind, s.id).toMatch(/^(agent|human)$/)
      for (const field of ['id', 'title', 'command', 'expect', 'assert'] as const)
        expect(String(s[field]).length, `${s.id}.${field}`).toBeGreaterThan(0)
    }
  })

  it('splits a secret into an agent step (the key) and a human step (the value)', () => {
    const steps = planSteps(fixtureManifest)
    const key = steps.find(s => s.id === 'secret-key:ORDERS_TOKEN')
    const value = steps.find(s => s.id === 'secret-value:ORDERS_TOKEN')
    expect(key?.kind).toBe('agent')
    expect(key?.assert).toContain('grep')
    // A credential is the one thing nothing can derive, which is the whole test for `human`.
    expect(value?.kind).toBe('human')
  })

  it('makes every destructive part of a REMOVE human, and nothing else', () => {
    const steps = removeSteps(classy, { archive: true, migrationTag: 'plugin-orders-v2' })
    const human = steps.filter(s => s.kind === 'human').map(s => s.id)
    // A `DROP TABLE`, the archive copy taken or knowingly skipped, a `deleted_classes` migration
    // that deletes a namespace and its contents, and live resources that may hold somebody's data.
    expect(human).toEqual(['archive', 'drop-migration', 'do-migration', 'deprovision'])
    expect(steps.filter(s => s.kind === 'agent').map(s => s.id)).toEqual([
      'dependencies:apps/web',
      'gate',
    ])
    // The DO tag is the NEXT free one, never a reused identity.
    expect(steps.find(s => s.id === 'do-migration')?.command).toContain('plugin-orders-v2')
    expect(steps.find(s => s.id === 'do-migration')?.command).toContain('deleted_classes')
  })

  it('renders human steps FIRST and under their own heading', () => {
    // A human step printed among the commands reads as one more command. The grouping is the
    // difference between a plan somebody acts on and a plan somebody skims.
    const text = renderSteps(planSteps(fixtureManifest)).join('\n')
    expect(text.indexOf('Human steps')).toBeLessThan(text.indexOf('Agent steps'))
    expect(text).toContain('       assert  ')
  })
})

describe('the plan as JSON', () => {
  it('carries every step with its kind, so a human step is a field and not a paragraph', () => {
    const json = addPlanJson({
      manifest: fixtureManifest,
      source: { repo: fixtureManifest.repo, subdir: '', ref: '1.1.0', commit: 'abc123' },
      host: { label: 'Acme', kitVersion: '0.6.1', recordsIn: MANIFEST_FILE, translated: true },
      vendored: false,
      problems: [],
      files: [
        { path: 'apps/web/src/plugins/orders/index.ts', role: 'copy' },
        { path: 'migrations/0001_seed.sql', role: 'fragment' },
      ],
      byRoot: { 'apps/web/src/plugins/orders/': 1 },
      barrels: ['server', 'worker'],
      verify: null,
    }) as Record<string, any>

    expect(json.plugin).toEqual({ id: 'orders', version: '1.1.0', label: 'Orders' })
    expect(json.installable).toBe(true)
    expect(json.files.fragments).toEqual(['migrations/0001_seed.sql'])
    expect(json.barrels).toContainEqual({
      kind: 'worker',
      file: 'apps/web/src/plugins/worker-exports.ts',
      lines: ["export * from './orders/worker-exports'"],
    })
    for (const step of json.steps) expect(['agent', 'human']).toContain(step.kind)
    expect(json.steps.some((s: { kind: string }) => s.kind === 'human')).toBe(true)
    // The fragment reached the steps, which is what makes `files` and `steps` one answer rather
    // than two that can disagree.
    expect(json.steps.some((s: { id: string }) => s.id === 'data-fragment')).toBe(true)
  })
})

/**
 * `pnpm plugin check` as the AGENT's oracle (D31).
 *
 * It was a six-point check that said what was wrong and not how to fix it — right for a person
 * with `reference.md` open, useless to an agent, who has only the line. The two properties under
 * test are that it is EXHAUSTIVE (it verifies rules that existed only as prose) and that every
 * finding carries the edit.
 */
describe('the audit', () => {
  const anchorFile = 'apps/web/src/plugins/example-feature/plugin.json'

  it('renders a finding as file, place, problem and the exact edit', () => {
    expect(
      renderDiagnostic({
        file: 'a/b.json',
        line: 7,
        problem: 'declares no version',
        fix: 'add "version": "0.1.0"',
      })
    ).toBe('a/b.json:7 declares no version — add "version": "0.1.0"')
    // No line rather than a fabricated one: the complaint is that the file is not there at all,
    // and a number that sends a reader somewhere real and wrong is worse than none.
    expect(renderDiagnostic({ file: 'a/b.ts', problem: 'is missing', fix: 'create it' })).toBe(
      'a/b.ts is missing — create it'
    )
  })

  it('finds a nested JSON key by walking the path FORWARDS', () => {
    const nested = ['{', '  "tables": "decoy",', '  "schema": {', '    "tables": []', '  }', '}']
    // The decoy is what a naive search for `"tables"` would answer, and it is the wrong line.
    expect(jsonKeyLine(nested.join('\n'), 'schema.tables')).toBe(4)
    expect(jsonKeyLine(read(anchorFile), 'id')).toBe(2)
    expect(jsonKeyLine(read(anchorFile), 'nope')).toBeNull()
  })

  it('fails a plugin that declares the contract and only warns one that does not', () => {
    // The two-tier rule the import enforcement already uses. `pnpm test` runs the gate a second
    // time with `defaultPlugins` installed at their pinned refs, and those releases predate every
    // rule added after them — a single tier either breaks CI on a plugin nobody can retroactively
    // change, or stays advisory for everyone and checks nothing.
    expect(auditSeverity({ requires: { pluginApi: '1' } })).toBe('fail')
    expect(auditSeverity({ requires: { pluginApi: '' } })).toBe('warn')
    expect(auditSeverity({ requires: {} })).toBe('warn')
    expect(auditSeverity(null)).toBe('warn')
    // The reference plugin is migrated, so the canary is live in the kit itself.
    expect(auditSeverity(JSON.parse(read(anchorFile)))).toBe('fail')
  })

  it("passes the kit's own reference manifest", () => {
    expect(pluginManifestProblems(JSON.parse(read(anchorFile)))).toEqual([])
  })

  it('names the FIELD and its legal values, never "invalid manifest"', () => {
    const problems = pluginManifestProblems({
      id: 'Orders',
      version: 'one',
      repo: 42,
      requires: { kit: 5, surfaces: 'feature-agents', plugins: [{}], pluginApi: 3 },
      dependencies: { 'apps/web': { 'date-fns': 3 } },
      bindings: [{ type: 'd1', binding: 'B', name: 'b' }],
      crons: ['* * *'],
      apiPrefixes: '/orders',
      vars: [{ key: 'ORDERS_TOKEN', secret: 'yes' }],
      schema: { tables: 'orders_orders' },
      coreEdits: [{ file: 'apps/web/vite.config.ts' }],
    })
    expect(problems.map(p => p.field)).toEqual(
      expect.arrayContaining([
        'id',
        'version',
        'repo',
        'apiPrefixes',
        'requires.kit',
        'requires.surfaces',
        'requires.plugins',
        'requires.pluginApi',
        'dependencies',
        'bindings',
        'crons',
        'vars',
        'schema.tables',
        'coreEdits',
      ])
    )
    // The whole point: a problem with no fix is the thing being replaced.
    for (const p of problems) expect(p.fix.length, p.field).toBeGreaterThan(0)
  })

  it('reads a manifest that is not an object at all', () => {
    expect(pluginManifestProblems(null)[0].problem).toMatch(/not a JSON object/)
    expect(pluginManifestProblems('{}')[0].problem).toMatch(/not a JSON object/)
  })

  it('reads the names a worker-exports half exports, and knows when it cannot', () => {
    expect(workerExportNames("export { OrdersHub } from './do'")).toEqual({
      names: ['OrdersHub'],
      opaque: false,
    })
    expect(workerExportNames("export { A as B } from './x'").names).toEqual(['B'])
    expect(workerExportNames('export class OrdersSyncWorkflow {}').names).toEqual([
      'OrdersSyncWorkflow',
    ])
    // A type is not a class Cloudflare can bind.
    expect(workerExportNames("export type { T } from './t'").names).toEqual([])
    expect(workerExportNames("export { type T } from './t'").names).toEqual([])
    // A star re-export needs the module resolved to enumerate, so BOTH directions of the check are
    // skipped rather than guessed — reporting "declares OrdersHub and does not export it" against
    // a file that plainly does teaches an author to distrust the whole audit.
    expect(workerExportNames("export * from './do'").opaque).toBe(true)
  })

  /**
   * **The mandatory tenant-isolation test, which nothing verified until now.**
   *
   * `docs/CONCEPTS.md` §16 and `.claude/rules/testing.md` both say a plugin declaring tenant-scoped
   * tables MUST own a test proving another organisation cannot read its rows — *because the kit
   * cannot*. Neither `plugins.test.ts` nor `helpers/plugins.ts` mentioned isolation at all, so the
   * one area the kit treats as non-negotiable had no enforcement whatsoever.
   */
  it("accepts the reference plugin's isolation test and refuses a stub", () => {
    const real = read('apps/web/src/plugins/example-feature/tests/api/example-feature.test.ts')
    expect(isolationEvidence(real).ok).toBe(true)
    // Two signals, because either alone is noise. Naming the property proves nothing on its own…
    expect(isolationEvidence("describe('tenant isolation', () => {})").ok).toBe(false)
    // …and creating two organisations proves nothing without a case that contrasts them.
    expect(isolationEvidence('createTestTenant(db); createTestTenant(db)').ok).toBe(false)
    expect(
      isolationEvidence("describe('tenant isolation')\ncreateTestTenant(db)\ncreateTestTenant(db)")
        .ok
    ).toBe(true)
    expect(
      isolationEvidence('const otherTenantId = x\ncreateTestTenant()\ncreateTestTenant()').ok
    ).toBe(true)
  })

  /**
   * The same failure mode as `declaresProperty`, in the check that matters most: a file whose
   * HEADER talks about tenant isolation, or whose two tenant creations are commented out, is talk
   * about the test rather than the test. Every source-scanning check strips comments first.
   */
  it('does not accept a commented-out isolation test', () => {
    const talk = [
      '/** Covers tenant isolation: createTestTenant twice, as a second organisation. */',
      '// createTestTenant(db)',
      '// createTestTenant(db)',
      "describe('notes', () => {})",
    ].join('\n')
    expect(isolationEvidence(talk).ok).toBe(false)
    expect(isolationEvidence(talk).tenantsCreated).toBe(0)
  })

  /**
   * **A check a COMMENT can talk its way past is worse than no check**, because it reports success.
   *
   * The fixture written to prove the `onTenantDeleted` rule works carried the sentence "declares no
   * `hooks.onTenantDeleted`" in its own doc comment, and the substring search this replaces was
   * satisfied by it — the rule passed on a plugin that plainly broke it.
   */
  it('tells a declaration from a mention of one', () => {
    expect(declaresProperty('hooks: { onTenantDeleted: async () => {} }', 'onTenantDeleted')).toBe(
      true
    )
    expect(declaresProperty('async onTenantDeleted(db) {}', 'onTenantDeleted')).toBe(true)
    expect(declaresProperty('// declares no onTenantDeleted', 'onTenantDeleted')).toBe(false)
    expect(declaresProperty('/** no onTenantDeleted here */', 'onTenantDeleted')).toBe(false)
    // A bare mention in code is not a declaration either.
    expect(declaresProperty('const x = onTenantDeleted', 'onTenantDeleted')).toBe(false)
    // A URL is not a line comment, so code after one is still read.
    expect(
      declaresProperty("const u = 'https://x.test'\nonTenantDeleted: 1", 'onTenantDeleted')
    ).toBe(true)
  })

  /**
   * The `??` bug, which was hit for real installing from a monorepo.
   *
   * Nullish-coalescing falls through only on `null`/`undefined`, so a manifest shipping
   * `"subdir": ""` — which every root-level plugin does — BEAT an explicit `--subdir`. Nothing
   * fails at install: it fails at the next `pnpm plugin upgrade`, which diffs and applies against
   * the recorded path and finds the plugin nowhere.
   */
  it('lets an explicit --subdir beat a manifest that ships an empty one', () => {
    expect(resolveSubdir({ flag: 'plugins/orders', manifest: '', source: 'plugins/orders' })).toBe(
      'plugins/orders'
    )
    // …and the manifest still wins when no flag was typed.
    expect(resolveSubdir({ flag: null, manifest: 'plugins/orders' })).toBe('plugins/orders')
    expect(resolveSubdir({ flag: '', manifest: '', source: 'plugins/orders' })).toBe(
      'plugins/orders'
    )
    expect(resolveSubdir({ flag: '/plugins/orders/', manifest: null })).toBe('plugins/orders')
    expect(resolveSubdir({})).toBe('')
  })

  /**
   * **Nothing checked that a declared dependency was ever installed.** `plugin add --apply` really
   * runs `pnpm --dir <pkg> add <name>@<range>`, and nothing looked again — so an install whose
   * `pnpm add` failed part-way, or a `remove` whose PRINTED `pnpm remove` somebody ran, left a
   * plugin whose imports cannot resolve while every other check read as clean.
   */
  it('catches a declared dependency the host package does not have', () => {
    const manifest = { id: 'orders', dependencies: { 'apps/web': { 'date-fns': '^3.0.0' } } }
    expect(missingDependencies(manifest, { 'apps/web': { dependencies: {} } })).toEqual([
      { pkg: 'apps/web', name: 'date-fns', range: '^3.0.0', have: null },
    ])
    // A different range is reported separately rather than as the same fault: `package.json` is
    // `manual` in `.rocketflare.json`, so an operator is entitled to have pinned it themselves.
    expect(
      missingDependencies(manifest, { 'apps/web': { dependencies: { 'date-fns': '^4.0.0' } } })
    ).toEqual([{ pkg: 'apps/web', name: 'date-fns', range: '^3.0.0', have: '^4.0.0' }])
    // A devDependency counts: what matters is whether the import resolves.
    expect(
      missingDependencies(manifest, { 'apps/web': { devDependencies: { 'date-fns': '^3.0.0' } } })
    ).toEqual([])
  })

  /**
   * **`pnpm add` silently overwrites the range in the host's `package.json`**, so two plugins
   * wanting different majors of one package was last-install-wins with nothing said — at the exact
   * moment somebody is approving an install that carries full Worker and database access.
   */
  it('detects a version clash with the host and with a peer plugin, before anything is written', () => {
    const manifest = { id: 'orders', dependencies: { 'apps/web': { recharts: '^2.12.0' } } }
    const withHost = dependencyClashes(manifest, {
      packageJsons: { 'apps/web': { dependencies: { recharts: '^3.0.0' } } },
    })
    expect(withHost).toHaveLength(1)
    expect(describeClash(withHost[0])).toContain('this plugin wants ^2.12.0')
    expect(describeClash(withHost[0])).toContain('^3.0.0')

    const withPeer = dependencyClashes(manifest, {
      installed: [{ id: 'analytics', dependencies: { 'apps/web': { recharts: '^3.0.0' } } }],
    })
    expect(withPeer).toHaveLength(1)
    expect(withPeer[0].holder).toContain('analytics')

    // Agreement is not a clash, and a plugin never clashes with itself on a re-read.
    expect(
      dependencyClashes(manifest, {
        packageJsons: { 'apps/web': { dependencies: { recharts: '^2.12.0' } } },
        installed: [{ id: 'orders', dependencies: { 'apps/web': { recharts: '^9.0.0' } } }],
      })
    ).toEqual([])
  })

  it('makes a clash a HUMAN step rather than refusing the install', () => {
    // Refusing would make an ordinary dependency upgrade impossible without editing somebody
    // else's manifest — a clash is very often the intended change. What it must not be is quiet,
    // so it lands where the taxonomy already makes a decision structurally unmissable.
    const clashes = dependencyClashes(
      { id: 'orders', dependencies: { 'apps/web': { recharts: '^2.12.0' } } },
      { packageJsons: { 'apps/web': { dependencies: { recharts: '^3.0.0' } } } }
    )
    const step = planSteps({ id: 'orders' }, { clashes }).find(s => s.id === 'dependency-clash')
    expect(step?.kind).toBe('human')
    expect(step?.command).toContain('recharts')
  })

  /**
   * `requires.kit` answers which kit RELEASES a plugin may be installed into; `requires.pluginApi`
   * answers which version of the CONTRACT it was written against. The comparison itself lives in
   * `scripts/lib/plugin-api.mjs` — this asserts only that `checkRequirements` consults it.
   */
  it('consults the plugin API version, and leaves an undeclared one to the warning', () => {
    const base = { kitVersion: '0.6.1', pluginApi: { current: 1, minSupported: 1 } }
    expect(checkRequirements({ ...base, requires: { pluginApi: '1' } })).toEqual([])
    expect(checkRequirements({ ...base, requires: { pluginApi: '2' } })).toHaveLength(1)
    expect(checkRequirements({ ...base, requires: { pluginApi: '2' } })[0]).toMatch(/newer than/)
    // Undeclared is never a refusal: a plugin released before the field existed cannot
    // retroactively declare one, and `analytics` 1.0.2 is the live case.
    expect(checkRequirements({ ...base, requires: {} })).toEqual([])
    // …and with no `pluginApi` handed in, nothing about it is checked at all.
    expect(checkRequirements({ kitVersion: '0.6.1', requires: { pluginApi: '99' } })).toEqual([])
  })

  it('reports the audit as DATA, with warnings kept out of the exit code', () => {
    const r = plugin(['check', '--json'])
    const json = JSON.parse(r.out) as {
      ok: boolean
      failures: unknown[]
      warnings: unknown[]
      plugins: { id: string; pluginApi: string | null }[]
    }
    expect(r.status).toBe(0)
    expect(json.ok).toBe(true)
    expect(json.failures).toEqual([])
    // `warnings` is a second list rather than a flag on the first, because `ok` has to keep
    // meaning "this exits 0".
    expect(Array.isArray(json.warnings)).toBe(true)
    if (subject) expect(json.plugins.map(p => p.id)).toContain(subject)
  })
})
