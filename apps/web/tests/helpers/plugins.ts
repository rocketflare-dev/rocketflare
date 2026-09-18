/**
 * The pure rules a well-formed plugin obeys (D31), factored out of `tests/config/plugins.test.ts`
 * so the suite can both exercise them with fixtures and run them over whatever is installed.
 *
 * They are string functions on purpose: the checks that matter here are structural (what a file
 * imports, how deep a specifier reaches), and a structural rule that cannot be unit-tested with a
 * fixture is one that quietly stops meaning anything the moment no plugin is installed — which is
 * the kit's own default state.
 */
import {
  DECLARED_ENTRIES,
  normaliseModulePath,
  PLUGIN_ROOTS,
  pluginIdOfPath,
  RESERVED_PLUGIN_IDS,
  resolveSpecifier,
  staticImports,
  suggestionFor,
} from '../../../../scripts/lib/surface.mjs'

export type { StaticImport } from '../../../../scripts/lib/surface.mjs'
/**
 * The import walk and the entry vocabulary live in `scripts/lib/surface.mjs` and are re-exported
 * here unchanged.
 *
 * They were defined in this file, and the same logic was then written a second time in
 * `scripts/plugin-api-doc.mjs` — so the suite and the tooling could disagree about what a plugin
 * imports, which is precisely the duplication-drift the observed-compatibility work exists to
 * remove. One definition, two readers. Everything below is the RULE (what is allowed), which is
 * this file's own business.
 */
export {
  DECLARED_ENTRIES,
  normaliseModulePath,
  pluginIdOfPath,
  RESERVED_PLUGIN_IDS,
  resolveSpecifier,
  staticImports,
}

/**
 * The barrels: the ONE place a plugin's inner files may be named from outside, because writing
 * those lines is precisely what installing a plugin is.
 */
export const BARRELS = [
  'apps/web/src/plugins/server.ts',
  'apps/web/src/plugins/ui.ts',
  'apps/web/src/plugins/schema.ts',
  'apps/web/src/plugins/worker-exports.ts',
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

/** Packages of the repo a plugin could reach into. Anything else is a third-party dependency. */
const HOST_ROOTS = [
  'apps/web/src/',
  'apps/web/tests/',
  'apps/cli/src/',
  'apps/cli/tests/',
  'packages/shared/src/',
]

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
 * Whether the rule FAILS the suite or only reports.
 *
 * **Failing, for every plugin — there is no longer a tier to opt into.** It used to key on a
 * plugin declaring `requires.pluginApi`, because the gate's second pass installed `defaultPlugins`
 * at refs that predated the surface and could not retroactively be changed. That tier went with
 * the field: a plugin now declares what it USES, the kit emits what it provides, and the two are
 * compared directly — so there is nothing left here a released plugin cannot satisfy by being
 * re-exported.
 *
 * Setting this to `'warn'` turns the whole rule into a report again — one line, and it says
 * exactly what it costs.
 */
export const PLUGIN_IMPORT_ENFORCEMENT: 'warn' | 'fail' = 'fail'
