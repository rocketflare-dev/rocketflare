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
 *     installing a plugin cannot quietly move its pages into the main bundle.
 *
 * Every check is a pure function over strings, exercised here with fixtures AND run over whatever
 * is installed. With no plugins installed the second half is vacuous — which is why the fixtures
 * are not optional: they are what keeps this suite meaningful in the kit itself.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isPluginId } from '@rocketflare/shared/plugins'
import { describe, expect, it } from 'vitest'
import { SERVER_PLUGINS, serverPlugins } from '@/plugins/server'
import { UI_PLUGINS, uiPlugins } from '@/plugins/ui'
import {
  deepImportIssue,
  isPluginEntry,
  pluginIdOfPath,
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

// ---- the same helpers, against what is actually installed ----------------------------------------

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => /\.tsx?$/.test(f))

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
    const prefixes = serverPlugins.flatMap(p => [
      ...(p.apiPrefixes ?? []),
      ...(p.mounts ?? []).map(m => m[0]),
    ])
    expect(new Set(prefixes).size, prefixes.join(', ')).toBe(prefixes.length)
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
})
