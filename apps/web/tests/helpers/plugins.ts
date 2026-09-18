/**
 * The pure rules a well-formed plugin obeys (D31), factored out of `tests/config/plugins.test.ts`
 * so the suite can both exercise them with fixtures and run them over whatever is installed.
 *
 * They are string functions on purpose: the checks that matter here are structural (what a file
 * imports, how deep a specifier reaches), and a structural rule that cannot be unit-tested with a
 * fixture is one that quietly stops meaning anything the moment no plugin is installed — which is
 * the kit's own default state.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Where a plugin's three trees live, by package. */
const PLUGIN_ROOTS = [
  'apps/web/src/plugins/',
  'packages/shared/src/plugins/',
  'apps/cli/src/plugins/',
] as const

/**
 * The barrels: the ONE place a plugin's inner files may be named from outside, because writing
 * those lines is precisely what installing a plugin is.
 */
export const BARRELS = [
  'apps/web/src/plugins/server.ts',
  'apps/web/src/plugins/ui.ts',
  'apps/web/src/plugins/schema.ts',
  'packages/shared/src/plugins/index.ts',
  'apps/cli/src/plugins/index.ts',
]

/**
 * What a plugin's `ui.ts` may import AT RUNTIME. Type-only imports are unrestricted — they are
 * erased, so they cannot weigh anything — and everything else must be on this list, which is the
 * eager shell plus the lazy loader itself. A page is never on it.
 */
const UI_ENTRY_ALLOWED = [
  'react',
  '@heroicons/react/24/outline',
  '@rocketflare/shared/',
  '@/plugins/types',
  // The WIRING half of the UI kit: the nav/route/guard vocabulary and nothing that renders. Its
  // components half (`@/plugins/api/ui`) is deliberately absent — that is for a lazy PAGE.
  '@/plugins/api/ui-wiring',
  '@/ui/components/SideNav',
  '@/ui/hooks/useNavGuard',
  '@/ui/lib/feature-guards',
]

// ---- pure helpers ------------------------------------------------------------------------------

/** Drop the extension and a trailing `/index`, so the four entry spellings normalise to one. */
export function normaliseModulePath(p: string): string {
  return p.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '')
}

/**
 * Names a plugin may not take as its id.
 *
 * Most are barrel FILENAMES: `plugins/ui.ts` and `plugins/ui/index.ts` would otherwise be two
 * different things spelled the same way in an import. `api` is the plugin API directory
 * (`plugins/api/**`), which is a host surface rather than a plugin and must classify as one —
 * without this, every core import of `@/plugins/api` would read as reaching into a plugin called
 * "api", and the directory would be reported as an installed plugin with no declared surface.
 */
export const RESERVED_PLUGIN_IDS = new Set(['index', 'server', 'ui', 'schema', 'types', 'api'])

/** The plugin id a repo-relative path belongs to, or null when it is not inside a plugin. */
export function pluginIdOfPath(repoPath: string): string | null {
  for (const root of PLUGIN_ROOTS) {
    if (!repoPath.startsWith(root)) continue
    const rest = repoPath.slice(root.length)
    const id = (rest.split('/')[0] ?? '').replace(/\.(tsx?|jsx?)$/, '')
    // The barrel files themselves belong to no plugin — and a specifier may arrive without an
    // extension (`./plugins/index`), so the name has to be checked, not just the dot.
    if (id === '' || id.includes('.') || RESERVED_PLUGIN_IDS.has(id)) return null
    return id
  }
  return null
}

/**
 * The published entries of a plugin: its server API, its UI, its shared contracts and its CLI
 * commands. Everything else in a plugin is private, which is what lets its semver cover a
 * knowable surface (decision 9).
 */
export function isPluginEntry(repoPath: string): boolean {
  const p = normaliseModulePath(repoPath)
  const id = pluginIdOfPath(repoPath)
  if (!id) return false
  for (const root of PLUGIN_ROOTS) {
    if (p === `${root}${id}` || p === `${root}${id}/ui`) return true
  }
  return false
}

/**
 * `@/x` → `apps/web/src/x`; `@rocketflare/shared/x` → `packages/shared/src/x`;
 * `@testkit/x` → `apps/web/tests/kit/x`; else relative.
 *
 * `@testkit` is resolved rather than left as an unknown bare specifier, which would be allowed by
 * accident. Mapping it makes it a DECLARED entry like the others — visible in `DECLARED_ENTRIES`,
 * and covered by the check that every entry exists on disk.
 */
export function resolveSpecifier(importer: string, specifier: string): string | null {
  if (specifier === '@testkit') return 'apps/web/tests/kit'
  if (specifier.startsWith('@testkit/'))
    return `apps/web/tests/kit/${specifier.slice('@testkit/'.length)}`
  if (specifier.startsWith('@/')) return `apps/web/src/${specifier.slice(2)}`
  if (specifier.startsWith('@rocketflare/shared/'))
    return `packages/shared/src/${specifier.slice('@rocketflare/shared/'.length)}`
  if (specifier.startsWith('.'))
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  return null
}

/**
 * One message when `importer` reaches past a plugin's published entry, else null. Importing from
 * INSIDE the same plugin is always fine, and so is a barrel line.
 */
export function deepImportIssue(importer: string, specifier: string): string | null {
  const target = resolveSpecifier(importer, specifier)
  if (!target) return null
  const targetPlugin = pluginIdOfPath(target)
  if (!targetPlugin) return null
  if (pluginIdOfPath(importer) === targetPlugin) return null
  if (BARRELS.includes(importer)) return null
  if (isPluginEntry(target)) return null
  return `${importer} imports ${specifier} — reach a plugin only through its entry (${targetPlugin}, ${targetPlugin}/ui)`
}

export interface StaticImport {
  specifier: string
  typeOnly: boolean
  /** 1-based, so a diagnostic can name the line to edit rather than only the file. */
  line: number
}

/** Static import/export specifiers of a TypeScript source, with whether the import is type-only. */
export function staticImports(source: string): StaticImport[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true)
  const out: StaticImport[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly)
        : node.isTypeOnly
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      out.push({ specifier: node.moduleSpecifier.text, typeOnly, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** Dynamic `import(...)` specifiers, and how many of them are wrapped in `lazy(() => …)`. */
export function dynamicImportShape(source: string): { total: number; lazy: number } {
  return {
    total: [...source.matchAll(/\bimport\s*\(/g)].length,
    lazy: [...source.matchAll(/\blazy\s*\(\s*\(\)\s*=>\s*import\s*\(/g)].length,
  }
}

/**
 * Everything wrong with a plugin's UI entry. Two rules, one reason: this file is imported by the
 * eager shell (`App.tsx`, `SideNav`), so anything it pulls in at runtime is in the main bundle for
 * every reader, including the ones who never open the plugin.
 */
export function uiEntryIssues(file: string, source: string): string[] {
  const issues: string[] = []
  for (const { specifier, typeOnly } of staticImports(source)) {
    if (typeOnly) continue
    if (specifier.startsWith('.') && !specifier.includes('/pages/')) continue
    if (UI_ENTRY_ALLOWED.some(a => (a.endsWith('/') ? specifier.startsWith(a) : specifier === a)))
      continue
    issues.push(`${file} imports ${specifier} at runtime — the UI entry ships in the main bundle`)
  }
  const { total, lazy } = dynamicImportShape(source)
  if (total !== lazy) {
    issues.push(`${file}: every page must be reached as lazy(() => import(...)) (${lazy}/${total})`)
  }
  return issues
}

/** Roots a plugin declares that do not carry its namespace. */
export function queryKeyRootIssues(id: string, roots: readonly string[]): string[] {
  return roots.filter(r => !r.startsWith(`${id}:`)).map(r => `${id}: query-key root '${r}'`)
}

// ---- the plugin import rule (D31) ----------------------------------------------------------------

/**
 * **A plugin imports only from declared entries, and receives everything else as injected context.**
 *
 * That sentence is the whole rule, and it is why there is no per-symbol allow-list here and no
 * exceptions list. The measurement this came from found 128 distinct (module, symbol) pairs across
 * 55 kit modules, and the answer to that is not a longer table — a table of 128 exceptions is the
 * sprawl written down rather than fixed. Nearly every one of those symbols already took an
 * execution context as its first argument, so nearly every one became a method on
 * `apps/web/src/plugins/api`.
 *
 * `deepImportIssue` above guards core→plugin and plugin→plugin. This guards the third direction —
 * **plugin→core** — which is the one that actually breaks: it is what makes a plugin's semver
 * meaningless, because the plugin is pinned to kit internals nobody promised to keep.
 */

/**
 * Where a plugin may import the host from. Resolved repo paths, so `@/x`, `../../x` and
 * `@rocketflare/shared/x` all land in the same vocabulary.
 */
export const DECLARED_ENTRIES = [
  // The server surface and the context family, plus the two UI halves and the peer escape hatches.
  'apps/web/src/plugins/api',
  // `ServerPlugin` / `UiPlugin` themselves.
  'apps/web/src/plugins/types',
  // The build-time schema symbols, which cannot be injected: a `pgTable(...)` runs at module scope.
  'apps/web/src/db/schema/kit',
  // The CLI half.
  'apps/cli/src/plugins/api',
  'apps/cli/src/plugins/types',
  // The TEST kit: `@testkit/integration` is the harness (a real database, the real app, the real
  // provider tree), `@testkit/unit` the context builders. A plugin's tests were out of scope for
  // this rule only because there was nowhere to point them; there is now.
  'apps/web/tests/kit',
  // Every shared contract module — the package is the contract, and a plugin's own schemas are
  // built out of it.
  'packages/shared/src',
]

/** Packages of the repo a plugin could reach into. Anything else is a third-party dependency. */
const HOST_ROOTS = [
  'apps/web/src/',
  'apps/web/tests/',
  'apps/cli/src/',
  'apps/cli/tests/',
  'packages/shared/src/',
]

/**
 * The edit, per kit module a plugin used to reach for.
 *
 * **Every diagnostic carries its replacement**, because installs are performed by agents and a
 * message that says only what is wrong gives one nothing to do. Longest prefix wins, so a whole
 * directory can be answered once and a particular module inside it more precisely.
 */
const SUGGESTED_ENTRY: ReadonlyArray<readonly [string, string]> = [
  ['apps/web/src/db/schema/rls', "import { tenantIsolation } from '@/db/schema/kit'"],
  ['apps/web/src/db/schema/_helpers', "import { tenantRef, timestamps } from '@/db/schema/kit'"],
  ['apps/web/src/db/schema/tenants', "import { tenants } from '@/db/schema/kit'"],
  ['apps/web/src/db/schema/users', "import { users } from '@/db/schema/kit'"],
  ['apps/web/src/db/schema/groups', "import { groups } from '@/db/schema/kit'"],
  [
    'apps/web/src/db/schema',
    "import { tenantRef, timestamps, tenantIsolation, tenants, users } from '@/db/schema/kit' — for a row TYPE, import type { Tenant } from '@/plugins/api'; for the whole merged namespace, allTables() from '@/plugins/api/peers'",
  ],
  [
    'apps/web/src/db/client',
    "the handle is ctx.db; for a signature, import type { Database } from '@/plugins/api'",
  ],
  [
    'apps/web/src/config',
    "the value is ctx.config; for a signature, import type { PluginConfig } from '@/plugins/api'",
  ],
  [
    'apps/web/src/api/utils/core/logger',
    "the value is ctx.logger; for a signature, import type { Logger } from '@/plugins/api'",
  ],
  [
    'apps/web/src/api/utils/core/errors',
    'throw through the context: ctx.notFound(…), ctx.forbidden(…), ctx.conflict(…)',
  ],
  [
    'apps/web/src/api/utils/routes/route-helpers',
    "const ctx = requestCtx(c) — import { requestCtx } from '@/plugins/api'",
  ],
  ['apps/web/src/api/utils/routes/router', "import { createRouter } from '@/plugins/api'"],
  ['apps/web/src/api/utils/routes/validate', "import { validate } from '@/plugins/api'"],
  [
    'apps/web/src/api/utils/routes/pagination',
    "ctx.page(items, total, query) — or import { pageWindow } from '@/plugins/api'",
  ],
  [
    'apps/web/src/api/middleware/permissions',
    'ctx.guard(action, subject) / ctx.can(action, subject)',
  ],
  ['apps/web/src/api/middleware/feature', "import { requireFeature } from '@/plugins/api'"],
  ['apps/web/src/api/services/jobs', 'ctx.enqueue(input) — the binding is already bound'],
  [
    'apps/web/src/api/services/realtime',
    "ctx.nudge(entity, id) — or import { realtimeEvent, nudge } from '@/plugins/api'",
  ],
  ['apps/web/src/api/services/notifications', "import { notify, notifyMany } from '@/plugins/api'"],
  ['apps/web/src/api/services/activity', "import { recordActivity } from '@/plugins/api'"],
  [
    'apps/web/src/api/services/storage',
    'ctx.storage() — 503 storage_not_configured without the binding',
  ],
  [
    'apps/web/src/api/services/access',
    "import { sharedWithMyGroups } from '@/plugins/api'; the scope is ctx.scope",
  ],
  [
    'apps/web/src/api/services/ai/kit',
    "import { defineTool } from '@/plugins/api'; the loop is ctx.toolLoop(…)",
  ],
  [
    'apps/web/src/api/services/ai',
    "import { recordUsage, AiNotConfiguredError } from '@/plugins/api'",
  ],
  ['apps/web/src/api/services/agents', "import { toolCtx, agentCtx } from '@/plugins/api'"],
  [
    'apps/web/src/api/observability',
    "import { withAgentTrace, traceChatClient } from '@/plugins/api'; the tracer is on the context",
  ],
  [
    'apps/web/src/api/queues/jobs',
    "const ctx = jobCtx(raw) — import { jobCtx } from '@/plugins/api'",
  ],
  [
    'apps/web/src/api/scheduled',
    "const ctx = cronCtx(raw) — import { cronCtx } from '@/plugins/api'",
  ],
  ['apps/web/src/api/workflows', "import { workflowCtx } from '@/plugins/api'"],
  ['apps/web/src/api/types', "import type { PluginBindings } from '@/plugins/api'"],
  [
    'apps/web/src/plugins/server',
    "import { extensions } from '@/plugins/api/peers' — never the barrel",
  ],
  [
    'apps/web/src/plugins/schema',
    "import { allTables } from '@/plugins/api/peers' — never the barrel",
  ],
  ['apps/web/src/ui/components/SideNav', "import type { NavItem } from '@/plugins/api/ui-wiring'"],
  ['apps/web/src/ui/hooks/useNavGuard', "import { useNavGuard } from '@/plugins/api/ui-wiring'"],
  ['apps/web/src/ui/lib/feature-guards', "import { featureGuard } from '@/plugins/api/ui-wiring'"],
  ['apps/web/src/ui/pages/Home', "import type { QuickLink } from '@/plugins/api/ui-wiring'"],
  ['apps/web/src/ui/components/shared', "import { … } from '@/plugins/api/ui' (a lazy page only)"],
  ['apps/web/src/ui/components', "import { … } from '@/plugins/api/ui' (a lazy page only)"],
  ['apps/web/src/ui/lib/api-client', "import { api } from '@/plugins/api/ui'"],
  ['apps/web/src/ui/lib/format', "import { formatDate } from '@/plugins/api/ui'"],
  ['apps/web/src/ui/hooks', "import { useAuth, usePermissions } from '@/plugins/api/ui'"],
  // The test harness. Longest prefix wins, so the particular modules answer before the catch-all.
  [
    'apps/web/tests/helpers/auth',
    "import { createTestUser, createTestTenantWithUser, createTestSession, sessionCookieHeader } from '@testkit/integration'",
  ],
  ['apps/web/tests/helpers/db', "import { setupTestDatabase } from '@testkit/integration'"],
  ['apps/web/tests/helpers/request', "import { request, json } from '@testkit/integration'"],
  ['apps/web/tests/mocks/bindings', "import { createTestEnv, stubs } from '@testkit/integration'"],
  [
    'apps/web/tests/ui/helpers/renderWithProviders',
    "import { renderWithProviders, makeSession, makeUser, rulesFor } from '@testkit/integration'",
  ],
  [
    'apps/web/tests',
    "the harness is '@testkit/integration'; a context builder (makeRequestCtx, makeJobCtx, makeToolCtx…) is '@testkit/unit'",
  ],
  ['apps/cli/src/context', "import { requireClient } from '../api'"],
  ['apps/cli/src/api', "import { CliApiError } from '../api'"],
  ['apps/cli/src/errors', "import { CliError } from '../api'"],
  ['apps/cli/src/utils/output', "import { renderTable, formatPagination } from '../api'"],
]

function suggestionFor(target: string): string {
  let best: readonly [string, string] | undefined
  for (const entry of SUGGESTED_ENTRY) {
    if (target === entry[0] || target.startsWith(`${entry[0]}/`)) {
      if (!best || entry[0].length > best[0].length) best = entry
    }
  }
  return best ? best[1] : "reach the host through '@/plugins/api' (or '@/plugins/api/ui' in a page)"
}

/**
 * Every file a plugin owns — its source AND its tests.
 *
 * The tests used to be out of scope, and the reason was honest rather than lenient: they import the
 * host's test harness, which is a coupling to the TEST rig rather than to the running application,
 * and there was no declared entry to point them at. `@testkit` is that entry, so the exemption has
 * gone with the gap that justified it. In practice this is where the worst of the coupling was —
 * six-level relative climbs into `apps/web/tests/**`, five modules, twenty-one symbols.
 */
export function isPluginFile(repoPath: string): boolean {
  return pluginIdOfPath(repoPath) !== null
}

/**
 * One message when a plugin file imports the host from anywhere but a declared entry, else null.
 *
 * Third-party packages (`react`, `zod`, `drizzle-orm`, `commander`) are not the host and are never
 * an issue; the rule is about coupling to kit INTERNALS.
 */
export function pluginImportIssue(
  importer: string,
  specifier: string,
  line?: number
): string | null {
  if (!isPluginFile(importer)) return null
  const target = resolveSpecifier(importer, specifier)
  // A bare specifier that is not `@/` or `@rocketflare/shared/` — an ordinary dependency.
  if (!target) return null
  // Its own files are always fine; another plugin's are `deepImportIssue`'s to report.
  if (pluginIdOfPath(target) === pluginIdOfPath(importer)) return null
  const normalised = normaliseModulePath(target)
  if (DECLARED_ENTRIES.some(e => normalised === e || normalised.startsWith(`${e}/`))) return null
  if (!HOST_ROOTS.some(root => `${normalised}/`.startsWith(root) || normalised.startsWith(root))) {
    return null
  }
  const where = `${importer.split('/').pop()}${line === undefined ? '' : `:${line}`}`
  return `${where} imports '${specifier}' — replace with: ${suggestionFor(normalised)}`
}

/**
 * What a plugin DECLARES about the contract it was written against, or null.
 *
 * `requires.pluginApi` in a plugin's own `plugin.json` is the opt-in: a plugin that declares it is
 * saying "I am written against the plugin context API", and is held to the import rule strictly. A
 * plugin that does not has said nothing, and is only warned about.
 *
 * **That two-tier reading is the whole reason the rule can be turned on at all.** `pnpm test` runs
 * the gate twice, the second time with `defaultPlugins` installed at their pinned refs — today that
 * is `analytics` at 1.0.2, which predates this surface entirely and still imports the old paths. A
 * single-tier rule would either fail that second pass (breaking CI on a released plugin nobody can
 * retroactively change) or stay warn-only for everyone. Declaring the contract is what moves a
 * plugin from the second group to the first, and it happens in the same release that migrates it.
 *
 * Read from the plugin's own manifest rather than from `.rocketflare.json`, because
 * `buildPluginSurface` copies only `kit`/`surfaces`/`plugins` into a surface — and because the
 * manifest is the plugin's statement about itself, which is exactly what is being asked here.
 */
export function pluginApiDeclaration(repoRoot: string, id: string): string | null {
  const manifestPath = path.join(repoRoot, 'apps/web/src/plugins', id, 'plugin.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      requires?: { pluginApi?: unknown }
    }
    const declared = manifest.requires?.pluginApi
    return typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : null
  } catch {
    // An unreadable manifest is not this rule's business to report — `pnpm plugin check` owns that.
    return null
  }
}

/**
 * Whether the rule FAILS the suite or only reports.
 *
 * **Failing**, for every plugin that declares `requires.pluginApi` (see above). The reference
 * plugin is migrated and declares it, so the canary is live; a plugin that predates the surface is
 * still warned about rather than broken, which is what keeps the second gate pass green on
 * `analytics` 1.0.2.
 *
 * Setting this back to `'warn'` turns the whole rule into a report again — one line, and it says
 * exactly what it costs.
 */
export const PLUGIN_IMPORT_ENFORCEMENT: 'warn' | 'fail' = 'fail'
