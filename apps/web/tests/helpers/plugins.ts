/**
 * The pure rules a well-formed plugin obeys, factored out of `tests/config/plugins.test.ts`
 * so the suite can both exercise them with fixtures and run them over whatever is installed.
 *
 * They are string functions on purpose: the checks that matter here are structural (what a file
 * imports, how deep a specifier reaches), and a structural rule that cannot be unit-tested with a
 * fixture is one that quietly stops meaning anything the moment no plugin is installed — which is
 * the default state.
 */

import { MAX_PUBLIC_MOUNT_BODY_BYTES } from '@/api/middleware/body-limit'
import { PUBLIC_SITE_HOST } from '@/api/middleware/public-sites'
import {
  isForbiddenCspSource,
  reachesAdminBundle,
  SITE_ASSETS_PATH,
} from '@/api/middleware/security-headers'
import type { AppConfig } from '@/config'
import type {
  AnyServerPlugin,
  PluginPublicMountOptions,
  PublicSiteCsp,
  PublicSiteFormPath,
} from '@/plugins/types'
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
 * knowable surface.
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

/**
 * A plugin's top-bar items (`UiPlugin.header`): each id a non-empty kebab-case word unique within
 * the plugin (the React key is `<plugin id>:<id>`), a placement the shell renders, a finite order.
 */
export function headerItemIssues(
  id: string,
  items: readonly { id: string; placement?: string; order?: number }[]
): string[] {
  const issues: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!/^[a-z][a-z0-9-]*$/.test(item.id)) issues.push(`${id}: header item id '${item.id}'`)
    if (seen.has(item.id)) issues.push(`${id}: header item '${item.id}' declared twice`)
    seen.add(item.id)
    if (item.placement !== undefined && item.placement !== 'center' && item.placement !== 'end') {
      issues.push(`${id}: header item '${item.id}' placement '${item.placement}'`)
    }
    if (item.order !== undefined && !Number.isFinite(item.order)) {
      issues.push(`${id}: header item '${item.id}' order must be a finite number`)
    }
  }
  return issues
}

/**
 * Where a plugin may mount a route with NO auth. Only `/api/hooks/<its own id>` and beneath,
 * so the unauthenticated surface is one enumerable prefix per plugin; and no AUTHED mount may sit
 * under `/api/hooks` at all, so a reader can trust that everything there is public by design.
 */
export function publicMountIssues(
  id: string,
  publicPrefixes: readonly string[],
  authedPrefixes: readonly string[]
): string[] {
  const root = `/api/hooks/${id}`
  const issues = publicPrefixes
    .filter(p => p !== root && !p.startsWith(`${root}/`))
    .map(p => `${id}: public mount '${p}' is outside ${root}`)
  for (const p of authedPrefixes) {
    if (p === '/api/hooks' || p.startsWith('/api/hooks/')) {
      issues.push(`${id}: authed mount '${p}' is under /api/hooks, which is public by definition`)
    }
  }
  return issues
}

/** A prefix that skips the 1 MB cap: only a plugin's own routes, and never its whole mount. */
export function uploadPathIssues(id: string, paths: readonly string[]): string[] {
  const root = `/api/${id}/`
  return paths
    .filter(p => !p.startsWith(root) || p.length === root.length)
    .map(p => `${id}: upload path '${p}' is outside ${root}`)
}

/**
 * The guards a public mount may declare (`PluginPublicMount`'s third element). `rateLimit` is
 * `false` or two positive integers — a zero `max` would refuse everything, and a fractional one
 * reads as a limit it does not enforce; `bodyLimitBytes` is a positive integer no larger than
 * `MAX_PUBLIC_MOUNT_BODY_BYTES`, so no plugin can make an unauthenticated prefix unbounded.
 */
export function publicMountOptionIssues(
  id: string,
  prefix: string,
  options: PluginPublicMountOptions | undefined
): string[] {
  if (options === undefined) return []
  const at = `${id}: public mount '${prefix}'`
  const issues: string[] = []
  const positiveInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0
  const { rateLimit, bodyLimitBytes } = options
  if (rateLimit !== undefined && rateLimit !== false) {
    if (!positiveInt(rateLimit.max)) issues.push(`${at}: rateLimit.max must be a positive integer`)
    if (!positiveInt(rateLimit.windowSeconds)) {
      issues.push(`${at}: rateLimit.windowSeconds must be a positive integer`)
    }
  }
  if (bodyLimitBytes !== undefined) {
    if (!positiveInt(bodyLimitBytes)) {
      issues.push(`${at}: bodyLimitBytes must be a positive integer`)
    } else if (bodyLimitBytes > MAX_PUBLIC_MOUNT_BODY_BYTES) {
      issues.push(
        `${at}: bodyLimitBytes ${bodyLimitBytes} exceeds the ${MAX_PUBLIC_MOUNT_BODY_BYTES}-byte ceiling`
      )
    }
  }
  return issues
}

/**
 * **One local part, one owner** (the `emailHandlers` slot). The dispatcher takes the first handler
 * whose local part matches, so a second plugin claiming `receipts` — or a second catch-all — is
 * silently dead code; the only place to see it is here. Local parts must also be in the form the
 * dispatcher compares against: lower-case, no `+tag`, no `@domain`.
 */
export function emailHandlerIssues(
  plugins: readonly { id: string; localParts: readonly string[] }[]
): string[] {
  const issues: string[] = []
  const owner = new Map<string, string>()
  for (const { id, localParts } of plugins) {
    for (const local of localParts) {
      if (local !== '*' && (local !== local.toLowerCase() || /[+@\s]/.test(local) || !local)) {
        issues.push(
          `${id}: email local part '${local}' must be lower-case with no '+', '@' or space`
        )
      }
      const prior = owner.get(local)
      if (prior) issues.push(`${id}: email local part '${local}' is already handled by ${prior}`)
      else owner.set(local, id)
    }
  }
  return issues
}

/** One plugin's `publicSites`, evaluated against a config so the rule below stays pure. */
export interface PublicSiteClaim {
  id: string
  /** `null` is the dormant answer: a config problem, not a malformed declaration. */
  hosts: readonly string[] | null
  forms?: readonly PublicSiteFormPath[]
  /** What `csp(host, config)` returned, for each claimed host. */
  csp?: readonly PublicSiteCsp[]
}

/** The claims of every installed plugin that declares `publicSites`. */
export function publicSiteClaims(
  plugins: readonly AnyServerPlugin[],
  config: AppConfig
): PublicSiteClaim[] {
  return plugins.flatMap(plugin => {
    const site = plugin.publicSites
    if (!site) return []
    const hosts = site.hosts(config)
    const { csp } = site
    return [
      {
        id: plugin.shared.id,
        hosts,
        forms: site.forms,
        csp: csp ? (hosts ?? []).map(host => csp(host, config)) : [],
      },
    ]
  })
}

/**
 * What a plugin's public hosts must obey. A host is lowercase DNS with no port, claimed by one
 * plugin only and never the app's own. A form path is exact and absolute, with the same guards as
 * a public mount. A CSP source may not reopen what the public policy closes (`isForbiddenCspSource`).
 */
export function publicSiteIssues(claims: readonly PublicSiteClaim[], appHost?: string): string[] {
  const issues: string[] = []
  const owner = new Map<string, string>()
  for (const { id, hosts, forms, csp } of claims) {
    for (const host of hosts ?? []) {
      if (!PUBLIC_SITE_HOST.test(host)) {
        issues.push(`${id}: public site host '${host}' must be lowercase with no scheme or port`)
      }
      if (host === appHost) issues.push(`${id}: public site host '${host}' is the app's own host`)
      const prior = owner.get(host)
      if (prior) issues.push(`${id}: public site host '${host}' is already claimed by ${prior}`)
      else owner.set(host, id)
    }
    for (const form of forms ?? []) {
      if (!/^\/(?!\/)[^?#*:\s]*$/.test(form.path)) {
        issues.push(`${id}: public site form path '${form.path}' must be an exact absolute path`)
      }
      issues.push(
        ...publicMountOptionIssues(id, form.path, {
          rateLimit: form.rateLimit,
          bodyLimitBytes: form.bodyLimitBytes,
        })
      )
    }
    for (const [index, declared] of (csp ?? []).entries()) {
      const host = hosts?.[index]
      for (const source of declared.scriptSrc ?? []) {
        if (host && !isForbiddenCspSource(source) && reachesAdminBundle(source, host)) {
          issues.push(
            `${id}: public site csp scriptSrc source '${source}' reaches ${host}/assets/, the admin bundle; site scripts load from ${SITE_ASSETS_PATH}`
          )
        }
      }
      for (const [directive, sources] of Object.entries(declared)) {
        for (const source of (sources ?? []) as readonly string[]) {
          if (isForbiddenCspSource(source)) {
            issues.push(`${id}: public site csp ${directive} source '${source}' is forbidden`)
          }
        }
      }
    }
  }
  return issues
}

// ---- the plugin import rule --------------------------------------------------------------------

/**
 * **A plugin imports only from declared entries, and receives everything else as injected context.**
 *
 * That sentence is the whole rule, and it is why there is no per-symbol allow-list here and no
 * exceptions list. The measurement this came from found 128 distinct (module, symbol) pairs across
 * 55 core modules, and the answer to that is not a longer table — a table of 128 exceptions is the
 * sprawl written down rather than fixed. Nearly every one of those symbols already took an
 * execution context as its first argument, so nearly every one became a method on
 * `apps/web/src/plugins/api`.
 *
 * `deepImportIssue` above guards core→plugin and plugin→plugin. This guards the third direction —
 * **plugin→core** — which is the one that actually breaks: it is what makes a plugin's semver
 * meaningless, because the plugin is pinned to core internals nobody promised to keep.
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

/** Where a plugin's seeded host code lives: `apps/web/src/host/<id>/`, imported as `@/host/<id>/…`. */
export const HOST_FILES_DIR = 'apps/web/src/host/'

/** The plugin id a resolved `apps/web/src/host/<id>/…` path belongs to, or null. */
export function hostDirIdOf(repoPath: string): string | null {
  if (!repoPath.startsWith(HOST_FILES_DIR)) return null
  return repoPath.slice(HOST_FILES_DIR.length).split('/')[0] || ''
}

/**
 * One message when a plugin file imports the host from anywhere but a declared entry, else null.
 *
 * Third-party packages (`react`, `zod`, `drizzle-orm`, `commander`) are not the host and are never
 * an issue; the rule is about coupling to core INTERNALS.
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
  // Its own files are always fine; another plugin's are `deepImportIssue`'s to report — and a
  // PUBLISHED entry of a plugin it requires is allowed, so every plugin path stops here.
  if (pluginIdOfPath(target) !== null) return null
  const normalised = normaliseModulePath(target)
  // `@/host/<id>/…` is the developer's half of a plugin — files it seeded (`hostFiles`) and the
  // developer owns since — so a plugin may import its OWN id's directory and nobody else's.
  const hostId = hostDirIdOf(normalised)
  if (hostId !== null) {
    const own = pluginIdOfPath(importer)
    if (hostId === own) return null
    const where = `${importer.split('/').pop()}${line === undefined ? '' : `:${line}`}`
    return `${where} imports '${specifier}' — a plugin imports only its own host files, '@/host/${own}/…'`
  }
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
 * plugin declaring `requires.pluginApi`, because the gate's second pass installed the CI plugins
 * at refs that predated the surface and could not retroactively be changed. That tier went with
 * the field: a plugin now declares what it USES, the host emits what it provides, and the two are
 * compared directly — so there is nothing left here a released plugin cannot satisfy by being
 * re-exported.
 *
 * Setting this to `'warn'` turns the whole rule into a report again — one line, and it says
 * exactly what it costs.
 */
export const PLUGIN_IMPORT_ENFORCEMENT: 'warn' | 'fail' = 'fail'
