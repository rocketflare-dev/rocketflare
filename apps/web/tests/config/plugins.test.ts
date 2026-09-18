/**
 * The "well-formed plugin" suite (D31, decisions 8 and 9).
 *
 * The division of labour: **a plugin tests its behaviour; the host tests that it is a well-formed
 * plugin.** A plugin's own tests live inside its directory and run in this same suite once it is
 * installed. What this file checks is the handful of properties the HOST depends on and which no
 * plugin author can verify for the combination of plugins a particular app has installed:
 *
 *   - ids are namespaces, so two plugins cannot collide and the kit is never one of them;
 *   - query-key roots carry the plugin's id, so one plugin's invalidation cannot wipe another's;
 *   - nothing reaches INTO a plugin except through its published entries, so a plugin's semver
 *     means something;
 *   - a plugin's `ui.ts` imports nothing heavy and reaches its pages only through `lazy()`, so
 *     installing a plugin cannot quietly move its pages into the main bundle;
 *   - the closed sets a plugin opens are still OPEN at the type level (the `expectTypeOf` block at
 *     the end), which is the one property no runtime assertion can reach.
 *
 * Every check is a pure function over strings, exercised here with fixtures AND run over whatever
 * is installed. With no plugins installed the second half is vacuous — which is why the fixtures
 * are not optional: they are what keeps this suite meaningful in the kit itself.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentKey, CORE_AGENT_KEYS } from '@rocketflare/shared/ai/agents'
import type { CoreJobType, JobOf, JobType } from '@rocketflare/shared/jobs'
import type { Subjects } from '@rocketflare/shared/permissions'
import {
  type AgentKeyOf,
  type FeatureKeyOf,
  isPluginId,
  type JobTypeOf,
  type SharedPlugin,
} from '@rocketflare/shared/plugins'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { SERVER_PLUGINS, serverPlugins } from '@/plugins/server'
import { UI_PLUGINS, uiPlugins } from '@/plugins/ui'
import { queryKeys } from '@/ui/lib/query-keys'
import {
  DECLARED_ENTRIES,
  deepImportIssue,
  isPluginEntry,
  isPluginFile,
  PLUGIN_IMPORT_ENFORCEMENT,
  pluginApiDeclaration,
  pluginIdOfPath,
  pluginImportIssue,
  queryKeyRootIssues,
  RESERVED_PLUGIN_IDS,
  staticImports,
  uiEntryIssues,
} from '../helpers/plugins'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

// ---- the helpers, against fixtures --------------------------------------------------------------

describe('plugin ids', () => {
  it('are a namespace, and never the kit', () => {
    expect(isPluginId('analytics')).toBe(true)
    expect(isPluginId('example-feature')).toBe(true)
    expect(isPluginId('Analytics')).toBe(false)
    expect(isPluginId('2fa')).toBe(false)
    expect(isPluginId('my_plugin')).toBe(false)
    // The rename translates a copy of the kit into somebody's app; an id carrying the kit's name
    // would be rewritten with everything else, and the barrel line would stop resolving.
    expect(isPluginId('rocketflare-extras')).toBe(false)
  })
})

describe('query-key roots', () => {
  it('must carry the plugin id, so one plugin cannot invalidate another', () => {
    expect(queryKeyRootIssues('orders', ['orders:list', 'orders:detail'])).toEqual([])
    expect(queryKeyRootIssues('orders', ['orders'])).toHaveLength(1)
    expect(queryKeyRootIssues('orders', ['documents'])).toHaveLength(1)
  })
})

describe('the plugin boundary', () => {
  it('reads a path as belonging to a plugin, and a barrel as belonging to none', () => {
    expect(pluginIdOfPath('apps/web/src/plugins/orders/api/routes.ts')).toBe('orders')
    expect(pluginIdOfPath('packages/shared/src/plugins/orders/index.ts')).toBe('orders')
    expect(pluginIdOfPath('apps/web/src/plugins/server.ts')).toBeNull()
    // The sixth barrel, added with worker-exports: without it this file reads as a plugin
    // called 'worker-exports', and its own line reads as a deep import into one.
    expect(pluginIdOfPath('apps/web/src/plugins/worker-exports.ts')).toBeNull()
    // An import specifier carries no extension, which is the spelling that used to read as a plugin
    // called "index".
    expect(pluginIdOfPath('packages/shared/src/plugins/index')).toBeNull()
    expect(pluginIdOfPath('apps/web/src/api/index.ts')).toBeNull()
  })

  it('knows the four published entries', () => {
    expect(isPluginEntry('apps/web/src/plugins/orders/index.ts')).toBe(true)
    expect(isPluginEntry('apps/web/src/plugins/orders/ui/index.ts')).toBe(true)
    expect(isPluginEntry('packages/shared/src/plugins/orders/index.ts')).toBe(true)
    expect(isPluginEntry('apps/cli/src/plugins/orders/index.ts')).toBe(true)
    expect(isPluginEntry('apps/web/src/plugins/orders/ui/pages/List.tsx')).toBe(false)
  })

  it('refuses a deep import from core, and from another plugin', () => {
    expect(
      deepImportIssue('apps/web/src/ui/pages/Home.tsx', '@/plugins/orders/ui/pages/List')
    ).toMatch(/reach a plugin only through its entry/)
    expect(
      deepImportIssue('apps/web/src/plugins/billing/api/routes.ts', '../../orders/api/service')
    ).toMatch(/orders/)
  })

  it('allows a plugin its own files, the entries, and the barrel lines', () => {
    expect(deepImportIssue('apps/web/src/plugins/orders/api/routes.ts', './service')).toBeNull()
    expect(deepImportIssue('apps/web/src/api/index.ts', '@/plugins/orders')).toBeNull()
    expect(deepImportIssue('apps/web/src/ui/App.tsx', '@/plugins/orders/ui')).toBeNull()
    // The schema barrel names a plugin's inner file by design — that line IS the installation.
    expect(deepImportIssue('apps/web/src/plugins/schema.ts', './orders/db/schema')).toBeNull()
    expect(
      deepImportIssue('apps/web/src/plugins/worker-exports.ts', './orders/worker-exports')
    ).toBeNull()
  })
})

describe('a plugin UI entry', () => {
  const good = `
    import { lazy } from 'react'
    import { CubeIcon } from '@heroicons/react/24/outline'
    import { ordersShared } from '@rocketflare/shared/plugins/orders/index'
    import type { UiPlugin } from '@/plugins/types'
    const OrdersPage = lazy(() => import('./pages/OrdersPage'))
    export const ordersUi: UiPlugin = { shared: ordersShared, routes: [{ path: '/orders', Component: OrdersPage }] }
  `

  it('passes when it only wires things up', () => {
    expect(uiEntryIssues('ui.ts', good)).toEqual([])
  })

  it('catches a page imported statically — the whole reason for the rule', () => {
    const bad = good.replace(
      "const OrdersPage = lazy(() => import('./pages/OrdersPage'))",
      "import OrdersPage from './pages/OrdersPage'"
    )
    expect(uiEntryIssues('ui.ts', bad)).toHaveLength(1)
    expect(uiEntryIssues('ui.ts', bad)[0]).toMatch(/main bundle/)
  })

  it('catches a dynamic import that is not a lazy component', () => {
    const bad = `${good}\nconst mod = await import('./pages/Other')`
    expect(uiEntryIssues('ui.ts', bad).join()).toMatch(/lazy\(\(\) => import/)
  })

  it('catches a heavy dependency, and lets a type-only import of one through', () => {
    expect(uiEntryIssues('ui.ts', `import { Chart } from 'recharts'\n${good}`)).toHaveLength(1)
    expect(uiEntryIssues('ui.ts', `import type { Chart } from 'recharts'\n${good}`)).toEqual([])
  })
})

describe('the plugin import rule', () => {
  const ROUTE = 'apps/web/src/plugins/orders/api/routes.ts'
  const TABLE = 'apps/web/src/plugins/orders/db/schema/orders.ts'

  it('names entries that all exist on disk', () => {
    // Vacuous the day an entry is renamed: the rule would then pass everything it used to catch.
    for (const entry of DECLARED_ENTRIES) {
      const candidates = [`${entry}.ts`, `${entry}/index.ts`, entry]
      expect(
        candidates.some(c => existsSync(path.join(REPO_ROOT, c))),
        entry
      ).toBe(true)
    }
  })

  it('passes a declared entry, in every spelling', () => {
    expect(pluginImportIssue(ROUTE, '@/plugins/api')).toBeNull()
    expect(pluginImportIssue(ROUTE, '@/plugins/types')).toBeNull()
    // The schema kit is reached relatively from a table file, which is how a plugin's own tree
    // spells it — four levels out of `plugins/<id>/db/schema`.
    expect(pluginImportIssue(TABLE, '../../../../db/schema/kit')).toBeNull()
    expect(pluginImportIssue(ROUTE, '@rocketflare/shared/plugins/orders/index')).toBeNull()
    expect(pluginImportIssue(ROUTE, '@rocketflare/shared/pagination')).toBeNull()
    expect(
      pluginImportIssue('apps/web/src/plugins/orders/ui/index.ts', '@/plugins/api/ui-wiring')
    ).toBeNull()
    expect(pluginImportIssue('apps/cli/src/plugins/orders/index.ts', '../api')).toBeNull()
  })

  it('leaves third-party packages and the plugin’s own files alone', () => {
    // The rule is about coupling to kit INTERNALS, not about dependencies.
    expect(pluginImportIssue(ROUTE, 'zod')).toBeNull()
    expect(pluginImportIssue(ROUTE, 'drizzle-orm')).toBeNull()
    expect(pluginImportIssue(ROUTE, 'react')).toBeNull()
    expect(pluginImportIssue(ROUTE, './service')).toBeNull()
    expect(pluginImportIssue(ROUTE, '../shared')).toBeNull()
  })

  it('says nothing about a core file — this guards ONE direction', () => {
    // `deepImportIssue` owns core→plugin and plugin→plugin; this owns plugin→core.
    expect(pluginImportIssue('apps/web/src/api/index.ts', '@/api/services/jobs')).toBeNull()
  })

  it('refuses a kit internal, and the message carries the EDIT', () => {
    // The whole point: an install is performed by an agent, and a diagnostic that says only what
    // is wrong gives one nothing to do.
    expect(pluginImportIssue(TABLE, '../../../../db/schema/rls', 4)).toBe(
      "orders.ts:4 imports '../../../../db/schema/rls' — replace with: " +
        "import { tenantIsolation } from '@/db/schema/kit'"
    )
    expect(pluginImportIssue(ROUTE, '@/api/services/jobs', 9)).toMatch(/ctx\.enqueue\(input\)/)
    expect(pluginImportIssue(ROUTE, '@/api/utils/routes/route-helpers')).toMatch(/requestCtx\(c\)/)
    expect(pluginImportIssue(ROUTE, '@/api/middleware/permissions')).toMatch(/ctx\.guard/)
    expect(pluginImportIssue(ROUTE, '@/api/utils/core/errors')).toMatch(/ctx\.notFound/)
    expect(
      pluginImportIssue('apps/web/src/plugins/orders/ui/pages/List.tsx', '@/ui/components/shared')
    ).toMatch(/@\/plugins\/api\/ui/)
  })

  it('falls back to naming the entry when it has no better suggestion', () => {
    expect(pluginImportIssue(ROUTE, '@/api/routes/members')).toMatch(/'@\/plugins\/api'/)
  })

  it('covers a plugin’s tests as well as its source', () => {
    const TEST = 'apps/web/src/plugins/orders/tests/api/orders.test.ts'
    expect(isPluginFile(ROUTE)).toBe(true)
    expect(isPluginFile(TEST)).toBe(true)
    expect(isPluginFile('apps/web/src/api/index.ts')).toBe(false)

    // The climb into the host's test tree is what `@testkit` replaced — and the diagnostic names
    // the entry rather than only the offence.
    // Five levels out of `plugins/<id>/tests/api` is `apps/web/`, which is how a plugin's test
    // actually spelled the climb before `@testkit` existed.
    expect(pluginImportIssue(TEST, '../../../../../tests/mocks/bindings', 7)).toBe(
      "orders.test.ts:7 imports '../../../../../tests/mocks/bindings' — replace with: " +
        "import { createTestEnv, stubs } from '@testkit/integration'"
    )
    expect(pluginImportIssue(TEST, '../../../../../tests/helpers/db')).toMatch(/setupTestDatabase/)
    expect(pluginImportIssue(TEST, '@testkit/integration')).toBeNull()
    expect(pluginImportIssue(TEST, '@testkit/unit')).toBeNull()
  })

  it('reads a plugin’s own declaration of the contract it was written against', () => {
    // The reference plugin is migrated, so it declares one — which is what puts it in the strict
    // group below. A plugin that predates the surface declares nothing and is only warned about.
    expect(pluginApiDeclaration(REPO_ROOT, 'example-feature')).not.toBeNull()
    expect(pluginApiDeclaration(REPO_ROOT, 'a-plugin-that-is-not-installed')).toBeNull()
  })
})

// ---- the same helpers, against what is actually installed ----------------------------------------

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => /\.tsx?$/.test(f))
  // `git ls-files` reads the INDEX, so a file deleted on disk and not yet staged is still listed.
  // `pnpm plugin remove --apply` deletes three directories and the gate runs BEFORE any `git add`,
  // so without this filter the scan dies with ENOENT on a file the tool correctly removed.
  .filter(f => existsSync(path.join(REPO_ROOT, f)))

describe('installed plugins', () => {
  it('the barrels agree on what is installed', () => {
    // A plugin may ship only a UI half or only a server half, so these are not equal sets — but an
    // id in either barrel must be a legal id, and must appear at most once in each.
    for (const barrel of [serverPlugins, uiPlugins]) {
      const ids = barrel.map(p => p.shared.id)
      expect(new Set(ids).size, ids.join(', ')).toBe(ids.length)
      for (const id of ids) {
        expect(isPluginId(id), id).toBe(true)
        expect(RESERVED_PLUGIN_IDS.has(id), `${id} is a barrel filename`).toBe(false)
      }
    }
    // The `as const` tuples and the widened lists are the same objects — A2 derives types from the
    // tuples, so a barrel whose two exports drifted would typecheck and mean nothing.
    expect(SERVER_PLUGINS.length).toBe(serverPlugins.length)
    expect(UI_PLUGINS.length).toBe(uiPlugins.length)
  })

  it('declares no API prefix or mount that collides with another plugin', () => {
    // Deduped WITHIN a plugin first, because both repetitions are normal and neither is a
    // collision: a prefix outside `/api` has to appear in `mounts` (the router) AND in
    // `apiPrefixes` (the SPA catch-all, the parity test, `run_worker_first`), and one router may be
    // mounted at two prefixes — the analytics plugin's `/cubejs-api` and `/mcp` are both
    // (drizzle-cube's adapter registers absolute paths). What must never happen is TWO plugins
    // claiming one prefix, because Hono matches in registration order and the loser is invisible.
    const claimed = serverPlugins.flatMap(p => [
      ...new Set([...(p.apiPrefixes ?? []), ...(p.mounts ?? []).map(m => m[0])]),
    ])
    expect(new Set(claimed).size, claimed.join(', ')).toBe(claimed.length)
  })

  it('namespaces every query-key root it declares', () => {
    const issues = uiPlugins.flatMap(p =>
      queryKeyRootIssues(p.shared.id, Object.keys(p.queryKeys ?? {}))
    )
    expect(issues).toEqual([])
  })

  it('is never reached past its published entry', () => {
    const issues: string[] = []
    for (const file of tracked) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const { specifier } of staticImports(source)) {
        const issue = deepImportIssue(file, specifier)
        if (issue) issues.push(issue)
      }
    }
    expect(issues).toEqual([])
  })

  it('keeps every UI entry free of pages and heavy dependencies', () => {
    const entries = tracked.filter(
      f => pluginIdOfPath(f) !== null && /\/(ui\.ts|ui\/index\.ts)$/.test(f)
    )
    const issues = entries.flatMap(f =>
      uiEntryIssues(f, readFileSync(path.join(REPO_ROOT, f), 'utf8'))
    )
    expect(issues).toEqual([])
  })

  it('reaches the host only through a declared entry', () => {
    /**
     * Two groups, and which one a plugin is in is the plugin's OWN statement about itself.
     *
     * A plugin that declares `requires.pluginApi` has said it is written against the plugin context
     * API, and is held to the rule strictly. One that does not predates the surface, and is warned
     * about — which is the only reason this can be enforced at all: `pnpm test` runs the gate a
     * second time with `defaultPlugins` installed at their pinned refs, and `analytics` 1.0.2 is
     * older than the surface and cannot be retroactively changed. A plugin moves between the groups
     * in the release that migrates it, by adding one manifest field.
     */
    const declared = new Map<string, boolean>()
    const declares = (id: string) => {
      const known = declared.get(id)
      if (known !== undefined) return known
      const answer = pluginApiDeclaration(REPO_ROOT, id) !== null
      declared.set(id, answer)
      return answer
    }

    const strict: string[] = []
    const legacy: string[] = []
    for (const file of tracked.filter(isPluginFile)) {
      const id = pluginIdOfPath(file)
      if (!id) continue
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      for (const { specifier, line } of staticImports(source)) {
        const issue = pluginImportIssue(file, specifier, line)
        if (!issue) continue
        ;(declares(id) ? strict : legacy).push(issue)
      }
    }

    if (legacy.length > 0) {
      console.warn(
        `\nplugin import rule — ${legacy.length} import(s) in plugins that declare no ` +
          'requires.pluginApi (warned, not failed; they predate the plugin context API):\n' +
          `${legacy.map(i => `  ${i}`).join('\n')}\n`
      )
    }

    if (PLUGIN_IMPORT_ENFORCEMENT !== 'fail') {
      if (strict.length > 0) {
        console.warn(`\nplugin import rule (warn-only):\n${strict.map(i => `  ${i}`).join('\n')}\n`)
      }
      return
    }

    expect(
      strict,
      'A plugin imports only from declared entries and receives everything else as injected ' +
        'context (D31). Each line below carries its replacement.'
    ).toEqual([])
  })
})

// ---- the closed sets, at the type level ---------------------------------------------------------

/**
 * `expectTypeOf` compiles to nothing, so these run in `pnpm typecheck` rather than in vitest — which
 * is where they belong: what they assert is that the derivations survive, not that a function
 * returns the right value.
 *
 * The first half pins the CORE shape (a closed set that quietly widened to `string` would still
 * pass every runtime test in the repo) and the RELATION between it and the installed set: core is
 * always a subset, never wider. It deliberately names no plugin — what `example-feature`
 * contributes is `example-feature`'s claim, and it lives in that plugin's own
 * `tests/config/contracts.test.ts`, which is deleted along with it. A host assertion naming the
 * reference plugin is a host that cannot uninstall it, and uninstalling it is the one thing it is
 * for. The second half is a FICTIONAL plugin, declared exactly as a real one is, showing that keys
 * reach `JobTypeOf` / `AgentKeyOf` / `FeatureKeyOf` without anything being installed for it.
 */
describe('the closed sets a plugin opens', () => {
  it('name the kit exactly, and widen for what is installed', () => {
    expectTypeOf<CoreJobType>().toEqualTypeOf<
      | 'email.send'
      | 'activity.record'
      | 'document.index'
      | 'document.convert'
      | 'chat.compact'
      | 'tenant.purge'
    >()
    // A plugin may only WIDEN the kit's set — the property the whole "variants are data" change
    // bought. Which types a particular plugin adds is that plugin's own test to make.
    expectTypeOf<CoreJobType>().toMatchTypeOf<JobType>()
    // The envelope narrows per type — what a handler is handed, and the reason `runHandler`'s
    // switch could go: this is the property that switch existed to provide.
    expectTypeOf<JobOf<'chat.compact'>['payload']['conversationId']>().toEqualTypeOf<string>()
    // The kit's own agent keys, pinned exactly; the installed union may only be wider.
    expectTypeOf<(typeof CORE_AGENT_KEYS)[number]>().toEqualTypeOf<
      'summarize-text' | 'research-topic'
    >()
    expectTypeOf<(typeof CORE_AGENT_KEYS)[number]>().toMatchTypeOf<AgentKey>()
    // A plugin's subjects union in beside the kit's; naming one is that plugin's own test.
    expectTypeOf<'Document'>().toMatchTypeOf<Subjects>()
    expectTypeOf(queryKeys.members.all).toEqualTypeOf<readonly ['members']>()
  })

  it('carry a plugin’s own keys through, once one declares them', () => {
    const ordersShared = {
      id: 'orders',
      label: 'Orders',
      agentKeys: ['orders-triage'],
      promptKeys: ['orders-triage'],
      subjects: ['Order'],
      features: {
        'orders-beta': {
          label: 'Orders beta',
          description: 'x',
          defaultState: 'off',
          defaultRolloutUnit: 'tenant',
          environmentGated: false,
        },
      },
      jobs: [
        z.object({ type: z.literal('orders.sync'), payload: z.object({ tenantId: z.string() }) }),
      ],
    } as const satisfies SharedPlugin

    type Orders = typeof ordersShared
    expectTypeOf<JobTypeOf<Orders>>().toEqualTypeOf<'orders.sync'>()
    expectTypeOf<AgentKeyOf<Orders>>().toEqualTypeOf<'orders-triage'>()
    expectTypeOf<FeatureKeyOf<Orders>>().toEqualTypeOf<'orders-beta'>()
  })
})
