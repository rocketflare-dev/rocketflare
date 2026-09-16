/**
 * The pure rules a well-formed plugin obeys (D31), factored out of `tests/config/plugins.test.ts`
 * so the suite can both exercise them with fixtures and run them over whatever is installed.
 *
 * They are string functions on purpose: the checks that matter here are structural (what a file
 * imports, how deep a specifier reaches), and a structural rule that cannot be unit-tested with a
 * fixture is one that quietly stops meaning anything the moment no plugin is installed — which is
 * the kit's own default state.
 */
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
 * The barrel filenames. A plugin may not take one of these as its id: `plugins/ui.ts` and
 * `plugins/ui/index.ts` would then be two different things spelled the same way in an import.
 */
export const RESERVED_PLUGIN_IDS = new Set(['index', 'server', 'ui', 'schema', 'types'])

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

/** `@/x` → `apps/web/src/x`; `@rocketflare/shared/x` → `packages/shared/src/x`; else relative. */
export function resolveSpecifier(importer: string, specifier: string): string | null {
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
      out.push({ specifier: node.moduleSpecifier.text, typeOnly })
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
