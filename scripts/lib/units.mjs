/**
 * The boundary check over every UNIT of an app — its installed plugins and its own domains — read
 * from source with a parser and no type checker (docs/CONCEPTS.md §20).
 *
 * In the spirit of Shopify's Packwerk: a unit is a directory tree with an id, a declared set of
 * edges and a public door, and the check is a walk over the imports that says which edge each one
 * is. It runs in two places — `apps/web/tests/config/units.test.ts` (so the gate enforces it in
 * every copy) and `pnpm plugin check` / `plugin add` (so an install is refused before anything is
 * copied) — and both read the findings this module returns, so the two cannot disagree.
 *
 * What it reports, each finding `fail` or `warn`:
 *
 * - ids: a legal id, not reserved (`core`, `kit`, `app`, or a name the kit's own modules use in a
 *   unit root), and no plugin and domain sharing one;
 * - edges: `dependsOn` names domains that exist, never itself, and has no cycle;
 * - imports: a domain reaches the kit only through the declared entries, another domain only
 *   through its `public.ts` (or its shared contracts) and only along a declared edge, and a plugin
 *   only through its published entries; a plugin never imports a domain; kit core never imports a
 *   domain except through the app's unit lists;
 * - tables: every table a domain defines is in its namespace, no two units define one name, and no
 *   unit defines a table inside a domain's namespace — except between two of the kit's examples,
 *   which share `example_` on purpose;
 * - direct use of ANOTHER unit's table objects: allowed, and a `warn` naming the file and the table
 *   and pointing at the owner's public functions, so the owner's rules apply and the edge shows.
 *
 * Job, event, route and query-key namespaces need the evaluated modules, so they are checked by
 * the config test, which has them; everything here works on files alone.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  DECLARED_ENTRIES,
  moduleImports,
  normaliseModulePath,
  PLUGIN_ROOTS,
  RESERVED_PLUGIN_IDS,
  resolveSpecifier,
  suggestionFor,
} from './surface.mjs'

// ---------------------------------------------------------------- vocabulary

/** Ids no unit may take: the kit itself (`core`), its event namespace (`kit`), the app's lists. */
export const RESERVED_UNIT_IDS = Object.freeze(['core', 'kit', 'app'])

export const UNIT_ID_RE = /^[a-z][a-z0-9-]*$/

/** The app's unit lists, by package. App-owned; the boundary check reads `web` to find domains. */
export const APP_LISTS = Object.freeze({
  web: 'apps/web/src/app.ts',
  ui: 'apps/web/src/app-ui.ts',
  schema: 'apps/web/src/app-schema.ts',
  shared: 'packages/shared/src/app.ts',
  cli: 'apps/cli/src/app.ts',
})

/** Where a domain's trees live: `<root><id>/`. Its tests are `apps/web/tests/<id>/`. */
export const DOMAIN_ROOTS = Object.freeze([
  'apps/web/src/',
  'packages/shared/src/',
  'apps/cli/src/',
  'apps/web/tests/',
])

/**
 * Top-level names the kit's own modules use in a domain root. A domain named after one would put
 * `apps/web/src/<id>/` beside — or on top of — a kit module of the same stem, and `@/<id>` would
 * name two things. `tests/kit-only/units.test.ts` keeps this in step with the kit's tree.
 */
export const KIT_ROOT_NAMES = Object.freeze([
  // apps/web/src
  'api',
  'app-schema',
  'app-ui',
  'config',
  'db',
  'host',
  'permissions',
  'platform',
  'plugins',
  'shared',
  'ui',
  'units',
  'worker',
  // packages/shared/src
  'access-requests',
  'activity',
  'admin',
  'ai',
  'api-keys',
  'auth',
  'branding',
  'errors',
  'features',
  'files',
  'gate',
  'groups',
  'home',
  'idp',
  'index',
  'jobs',
  'mcp',
  'notifications',
  'oauth',
  'pagination',
  'paths',
  'realtime',
  'tenant-settings',
  'tenants',
  'uploads',
  'user-settings',
  // apps/cli/src
  'cli',
  'commands',
  'context',
  'package-info',
  'utils',
  // apps/web/tests
  'agent-recordings',
  'api-fixtures-setup',
  'api-setup',
  'driver',
  'helpers',
  'kit',
  'kit-only',
  'mocks',
  'setup',
])

// The parser is loaded at the point of use, as `surface.mjs` loads its own: `pnpm plugin list`
// and friends import this module and never parse, and must run before `pnpm install` has.
const require = createRequire(import.meta.url)
let parser = null
const parseSync = (file, source, options) => {
  parser ??= require('oxc-parser')
  return parser.parseSync(file, source, options)
}
const createExportReader = options => require('./module-exports.mjs').createExportReader(options)

const SOURCE_FILE = /\.(tsx?|jsx?|mts|mjs)$/

// ---------------------------------------------------------------- small readers

function exists(repoRoot, rel) {
  return fs.existsSync(path.join(repoRoot, rel))
}

function read(repoRoot, rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

/** Every source file under `dir`, repo-relative and sorted. */
export function sourceFilesUnder(repoRoot, dir) {
  const base = dir.replace(/\/$/, '')
  if (!exists(repoRoot, base)) return []
  const out = []
  const walk = current => {
    for (const entry of fs.readdirSync(path.join(repoRoot, current), { withFileTypes: true })) {
      const rel = `${current}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(rel)
      } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel)
    }
  }
  walk(base)
  return out.sort()
}

function parse(file, source) {
  const result = parseSync(file, source, { sourceType: 'module' })
  if (result.errors.length > 0) {
    throw new Error(`${file}: ${result.errors.map(e => e.message).join('; ')}`)
  }
  return result.program
}

/** 1-based line of a character offset. */
function lineAt(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** Visit every node of an oxc AST. */
function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (value && typeof value === 'object') walkAst(value, visit)
  }
}

const stringOf = node =>
  node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0
      ? node.quasis.map(q => q.value.cooked).join('')
      : null

// ---------------------------------------------------------------- discovering units

/**
 * The domain ids `apps/web/src/app.ts` imports, in source order — each import of `./<id>` (or
 * `./<id>/index`). A missing file is no domains, not an error: a copy older than domains has none.
 */
export function appDomainIds(repoRoot, listFile = APP_LISTS.web) {
  if (!exists(repoRoot, listFile)) return []
  const dir = path.posix.dirname(listFile)
  const ids = []
  for (const imported of moduleImports(read(repoRoot, listFile), listFile)) {
    if (imported.typeOnly) continue
    const target = resolveSpecifier(listFile, imported.specifier)
    if (!target) continue
    const rel = normaliseModulePath(target)
    if (!rel.startsWith(`${dir}/`)) continue
    const id = rel.slice(dir.length + 1).split('/')[0]
    if (id && id !== 'plugins' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The installed plugins' ids: the directories under `apps/web/src/plugins/` that are not barrels. */
export function pluginIds(repoRoot) {
  const dir = path.join(repoRoot, 'apps/web/src/plugins')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !RESERVED_PLUGIN_IDS.has(e.name))
    .map(e => e.name)
    .sort()
}

/**
 * `{ dependsOn, tablePrefix, tables, problems }` read from the object literal handed to
 * `defineDomain(...)` in a domain's `index.ts`. These three are read from SOURCE, so they must be
 * literals; anything else is a problem naming the property, never a silently empty edge list.
 */
export function readDomainDefinition(source, file = 'index.ts') {
  const program = parse(file, source)
  let literal = null
  walkAst(program, node => {
    if (literal) return
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'defineDomain' &&
      node.arguments?.[0]?.type === 'ObjectExpression'
    ) {
      literal = node.arguments[0]
    }
  })
  const out = {
    found: Boolean(literal),
    dependsOn: [],
    tablePrefix: null,
    tables: null,
    problems: [],
  }
  if (!literal) return out
  for (const prop of literal.properties) {
    if (prop.type !== 'Property' || prop.computed) continue
    const key = prop.key.type === 'Identifier' ? prop.key.name : stringOf(prop.key)
    const at = lineAt(source, prop.start)
    if (key === 'dependsOn' || key === 'tables') {
      const value = prop.value
      const items = value.type === 'ArrayExpression' ? value.elements.map(e => stringOf(e)) : [null]
      if (items.some(i => i === null)) {
        out.problems.push({
          property: key,
          line: at,
          problem: `${key} must be an array of string literals`,
        })
        continue
      }
      if (key === 'dependsOn') out.dependsOn = items
      else out.tables = items
    }
    if (key === 'tablePrefix') {
      const value = stringOf(prop.value)
      if (value === null) {
        out.problems.push({
          property: key,
          line: at,
          problem: 'tablePrefix must be a string literal',
        })
      } else out.tablePrefix = value
    }
  }
  return out
}

/**
 * Every `pgTable('<name>', …)` in `files`: `{ name, exportName, file, line }`. `exportName` is the
 * binding it is exported as (`export const exampleLeads = pgTable(...)`), or null.
 */
export function tableDefinitions(repoRoot, files) {
  const out = []
  for (const file of files) {
    const source = read(repoRoot, file)
    if (!source.includes('pgTable')) continue
    const program = parse(file, source)
    const exportedAs = new Map()
    for (const node of program.body) {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : null
      if (decl?.type !== 'VariableDeclaration') continue
      for (const d of decl.declarations) {
        if (d.id?.type === 'Identifier' && d.init) exportedAs.set(d.init, d.id.name)
      }
    }
    walkAst(program, node => {
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        node.callee.name === 'pgTable'
      ) {
        const name = stringOf(node.arguments?.[0])
        if (name === null) return
        out.push({
          name,
          exportName: exportedAs.get(node) ?? null,
          file,
          line: lineAt(source, node.start),
        })
      }
    })
  }
  return out
}

/** The trees a unit owns, by kind. */
export function unitTrees(kind, id) {
  if (kind === 'plugin') return PLUGIN_ROOTS.map(root => `${root}${id}`)
  return DOMAIN_ROOTS.map(root => `${root}${id}`)
}

/** The unit (`{ kind, id }`) a repo path belongs to, or null for kit core. */
export function unitOfPath(repoPath, units) {
  const p = normaliseModulePath(repoPath)
  for (const unit of units) {
    for (const tree of unit.trees) if (p === tree || p.startsWith(`${tree}/`)) return unit
  }
  return null
}

/** The default table namespace: the first hyphen-separated segment of the id, then `_`. */
export const defaultTablePrefix = id => `${id.split('-')[0].replace(/-/g, '_')}_`

/** Whether `table` is inside `unit`'s namespace (its allow-list, else its prefix). */
export function inNamespace(unit, table) {
  if (unit.tables) return unit.tables.includes(table)
  return table.startsWith(unit.tablePrefix)
}

/**
 * Whether a unit is one of the kit's own examples: recorded in `.rocketflare.json` as a
 * `kind: "example"` surface, or as the plugin the kit vendors as its reference (no repository of
 * its own). Examples alone may share a table namespace — `example_` — because an example is copied
 * or deleted, never extended in place.
 */
const normRepo = repo =>
  typeof repo === 'string' ? repo.replace(/\.git$/, '').replace(/\/$/, '') : null

export function exampleIdsOf(manifest) {
  const kitRepo = manifest?.kit?.repo ?? null
  const norm = normRepo
  const ids = new Set()
  for (const s of manifest?.surfaces ?? []) {
    if (s.kind === 'example') ids.add(s.id)
    if (
      s.kind === 'plugin' &&
      s.source &&
      norm(s.source.repo) === norm(kitRepo) &&
      !s.source.subdir
    ) {
      ids.add(s.id)
    }
  }
  return ids
}

/**
 * Every unit of the checkout at `repoRoot`:
 * `{ kind, id, trees, files, dependsOn, tablePrefix, tables, definedTables, example, problems }`.
 * `manifest` is the parsed `.rocketflare.json` (for which units are examples), optional.
 */
export function readUnits(repoRoot, { manifest = null } = {}) {
  const examples = exampleIdsOf(manifest)
  const units = []
  for (const id of pluginIds(repoRoot)) {
    const trees = unitTrees('plugin', id)
    const files = trees.flatMap(t => sourceFilesUnder(repoRoot, t))
    const dbFiles = files.filter(f => f.startsWith(`apps/web/src/plugins/${id}/db/`))
    units.push({
      kind: 'plugin',
      id,
      trees,
      files,
      dependsOn: [],
      tablePrefix: defaultTablePrefix(id),
      tables: null,
      definedTables: tableDefinitions(repoRoot, dbFiles),
      example: examples.has(id),
      problems: [],
    })
  }
  for (const id of appDomainIds(repoRoot)) {
    const trees = unitTrees('domain', id)
    const files = trees.flatMap(t => sourceFilesUnder(repoRoot, t))
    const entry = `apps/web/src/${id}/index.ts`
    const problems = []
    let definition = { found: false, dependsOn: [], tablePrefix: null, tables: null, problems: [] }
    if (exists(repoRoot, entry)) {
      definition = readDomainDefinition(read(repoRoot, entry), entry)
      for (const p of definition.problems) {
        problems.push({
          file: entry,
          line: p.line,
          problem: p.problem,
          fix: `write ${p.property} inline as a literal — the boundary check reads it from source`,
        })
      }
    }
    if (!definition.found) {
      problems.push({
        file: entry,
        line: null,
        problem: `is listed in ${APP_LISTS.web} but has no defineDomain({ … }) in ${entry}`,
        fix: `export const <name> = defineDomain({ id: '${id}', shared, … }) from ${entry}`,
      })
    }
    const dbFiles = files.filter(f => f.startsWith(`apps/web/src/${id}/db/`))
    units.push({
      kind: 'domain',
      id,
      trees,
      files,
      dependsOn: definition.dependsOn,
      tablePrefix: definition.tablePrefix ?? defaultTablePrefix(id),
      tables: definition.tables,
      definedTables: tableDefinitions(repoRoot, dbFiles),
      example: examples.has(id),
      problems,
    })
  }
  return units
}

// ---------------------------------------------------------------- the checks

const finding = (severity, unit, kind, d) => ({ severity, unit, kind, ...d, line: d.line ?? null })

/** `null` when `id` may name a unit of `kind`, else why not. */
export function unitIdProblem(id, kind = 'domain') {
  if (typeof id !== 'string' || !UNIT_ID_RE.test(id)) {
    return `'${id}' must match ${UNIT_ID_RE.source}`
  }
  if (RESERVED_UNIT_IDS.includes(id)) return `'${id}' is a reserved unit id (core, kit, app)`
  if (kind === 'domain' && KIT_ROOT_NAMES.includes(id)) {
    return `'${id}' is the name of a kit module in a domain root (apps/web/src/${id}…)`
  }
  if (kind === 'domain' && RESERVED_PLUGIN_IDS.has(id)) return `'${id}' is a barrel filename`
  return null
}

/** Ids, edges and the app lists. */
export function identityFindings(repoRoot, units) {
  const out = []
  const byId = new Map()
  for (const u of units) {
    for (const p of u.problems) out.push(finding('fail', u.id, 'definition', p))
    const problem = unitIdProblem(u.id, u.kind)
    if (problem) {
      out.push(
        finding('fail', u.id, 'id', {
          file: u.kind === 'domain' ? APP_LISTS.web : `apps/web/src/plugins/${u.id}`,
          problem,
          fix: 'rename the unit — its id keys its tables, jobs, events, routes and query keys',
        })
      )
    }
    if (u.kind === 'domain') {
      for (const root of ['apps/web/src/', 'packages/shared/src/', 'apps/cli/src/']) {
        for (const ext of ['.ts', '.tsx']) {
          if (exists(repoRoot, `${root}${u.id}${ext}`)) {
            out.push(
              finding('fail', u.id, 'id', {
                file: `${root}${u.id}${ext}`,
                problem: `shares its stem with the domain '${u.id}', so '${root}${u.id}' names two modules`,
                fix: 'rename the domain or the module',
              })
            )
          }
        }
      }
    }
    const holders = byId.get(u.id) ?? []
    holders.push(u)
    byId.set(u.id, holders)
  }
  for (const [id, holders] of byId) {
    if (holders.length < 2) continue
    out.push(
      finding('fail', id, 'id-collision', {
        file: APP_LISTS.web,
        problem: `'${id}' is both ${holders.map(h => `a ${h.kind}`).join(' and ')}`,
        fix:
          'one id per unit: every namespace (tables, jobs, events, /api/<id>, query keys) is keyed ' +
          'by it — rename the domain, or remove one of them',
      })
    )
  }
  // The app lists agree with app.ts: a domain's UI, tables, contracts or commands listed without
  // its server half is a domain the registries cannot see.
  const domainIds = new Set(units.filter(u => u.kind === 'domain').map(u => u.id))
  for (const [half, file] of Object.entries(APP_LISTS)) {
    if (half === 'web') continue
    for (const id of appDomainIds(repoRoot, file)) {
      if (domainIds.has(id)) continue
      out.push(
        finding('fail', id, 'app-list', {
          file,
          problem: `lists '${id}', which ${APP_LISTS.web} does not`,
          fix: `add the domain's server half to ${APP_LISTS.web}, or drop the line here`,
        })
      )
    }
  }
  // Edges.
  const domains = units.filter(u => u.kind === 'domain')
  for (const u of domains) {
    for (const dep of u.dependsOn) {
      const target = units.find(x => x.id === dep)
      if (dep === u.id || !target || target.kind !== 'domain') {
        out.push(
          finding('fail', u.id, 'depends-on', {
            file: `apps/web/src/${u.id}/index.ts`,
            problem:
              dep === u.id
                ? `lists itself in dependsOn`
                : !target
                  ? `dependsOn names '${dep}', which is not a domain of this app`
                  : `dependsOn names the plugin '${dep}' — a plugin needs no edge; import its published entry`,
            fix: 'dependsOn lists the other domains this one reads from or writes through',
          })
        )
      }
    }
  }
  for (const cycle of dependencyCycles(domains)) {
    out.push(
      finding('fail', cycle[0], 'cycle', {
        file: `apps/web/src/${cycle[0]}/index.ts`,
        problem: `dependsOn has a cycle: ${[...cycle, cycle[0]].join(' → ')}`,
        fix:
          'break it: the domain that only needs to hear that something happened should subscribe ' +
          "to the other's event instead of calling its public.ts",
      })
    )
  }
  return out
}

/** Every elementary cycle in the `dependsOn` graph, each once, starting at its smallest id. */
export function dependencyCycles(domains) {
  const edges = new Map(domains.map(d => [d.id, d.dependsOn.filter(x => x !== d.id)]))
  const seen = new Set()
  const cycles = []
  const visit = (start, node, trail) => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) {
        const cycle = [...trail]
        const min = [...cycle].sort()[0]
        const rotated = [...cycle.slice(cycle.indexOf(min)), ...cycle.slice(0, cycle.indexOf(min))]
        const key = rotated.join('>')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(rotated)
        }
      } else if (!trail.includes(next) && edges.has(next)) visit(start, next, [...trail, next])
    }
  }
  for (const id of [...edges.keys()].sort()) visit(id, id, [id])
  return cycles
}

/** Table names: inside the owner's namespace, unique, and never inside a domain's namespace. */
export function tableFindings(units) {
  const out = []
  for (const u of units.filter(x => x.kind === 'domain')) {
    for (const t of u.definedTables) {
      if (inNamespace(u, t.name)) continue
      out.push(
        finding('fail', u.id, 'table-namespace', {
          file: t.file,
          line: t.line,
          problem: u.tables
            ? `defines the table ${t.name}, which its tables: [...] does not list`
            : `defines the table ${t.name}, outside its namespace '${u.tablePrefix}'`,
          fix: u.tables
            ? `add '${t.name}' to tables in apps/web/src/${u.id}/index.ts`
            : `name it '${u.tablePrefix}…', or declare tablePrefix / tables in defineDomain for a table that already exists`,
        })
      )
    }
  }
  const holders = new Map()
  for (const u of units) {
    for (const t of u.definedTables) {
      const list = holders.get(t.name) ?? []
      list.push({ unit: u, table: t })
      holders.set(t.name, list)
    }
  }
  for (const [name, list] of holders) {
    const owners = [...new Set(list.map(l => l.unit.id))]
    if (owners.length < 2) continue
    // Two PLUGINS sharing a name is `pnpm plugin check`'s finding (`tableClashes`), read from their
    // manifests; this one is about a domain in the mix.
    if (list.every(l => l.unit.kind === 'plugin')) continue
    for (const { unit, table } of list) {
      out.push(
        finding('fail', unit.id, 'table-collision', {
          file: table.file,
          line: table.line,
          problem: `defines the table ${name}, which ${owners
            .filter(o => o !== unit.id)
            .map(o => `'${o}'`)
            .join(', ')} also defines`,
          fix: 'rename one of them — a single DROP TABLE would take the other unit’s data',
        })
      )
    }
  }
  for (const owner of units.filter(x => x.kind === 'domain')) {
    for (const other of units) {
      if (other === owner || (owner.example && other.example)) continue
      for (const t of other.definedTables) {
        if (!inNamespace(owner, t.name)) continue
        out.push(
          finding('fail', other.id, 'table-namespace-collision', {
            file: t.file,
            line: t.line,
            problem: `defines the table ${t.name}, inside the domain '${owner.id}'s namespace (${owner.tables ? 'its tables list' : `'${owner.tablePrefix}'`})`,
            fix:
              `give '${owner.id}' an exact tables: [...] list in defineDomain, or rename the table — ` +
              'two units in one namespace cannot be told apart by a table name',
          })
        )
      }
    }
  }
  return out
}

/** The public door of a domain: its `public.ts`, or the entry of its shared contracts. */
export function isDomainPublicEntry(target, id) {
  const p = normaliseModulePath(target)
  return p === `apps/web/src/${id}/public` || p === `packages/shared/src/${id}`
}

/** A plugin's published entries: server, UI, shared contracts, CLI commands. */
export function isPluginPublishedEntry(target, id) {
  const p = normaliseModulePath(target)
  return PLUGIN_ROOTS.some(root => p === `${root}${id}` || p === `${root}${id}/ui`)
}

const HOST_ROOTS = [
  'apps/web/src/',
  'apps/web/tests/',
  'apps/cli/src/',
  'apps/cli/tests/',
  'packages/shared/src/',
]

const isDeclared = target => DECLARED_ENTRIES.some(e => target === e || target.startsWith(`${e}/`))

const appListFiles = new Set(Object.values(APP_LISTS).map(normaliseModulePath))

/**
 * The import walk. One finding per import that crosses a boundary it may not, and a `warn` per
 * imported table object of another unit (directly, or re-exported through its door).
 */
export function importFindings(repoRoot, units, { coreFiles = null } = {}) {
  const out = []
  const reader = createExportReader({ repoRoot, resolve: resolveSpecifier })
  const tableExports = new Map()
  for (const u of units) {
    for (const t of u.definedTables) {
      if (!t.exportName) continue
      const key = normaliseModulePath(t.file)
      const names = tableExports.get(key) ?? new Map()
      names.set(t.exportName, t.name)
      tableExports.set(key, names)
    }
  }
  /** The table a name imported from `target` resolves to, when it is one of `owner`'s. */
  const tableOf = (target, name, owner) => {
    let file = null
    try {
      const resolved = reader.resolveExport(fileFor(repoRoot, target) ?? target, name)
      file = resolved?.file ?? null
    } catch {
      return null
    }
    if (!file || unitOfPath(file, units) !== owner) return null
    return tableExports.get(normaliseModulePath(file))?.get(name) ?? null
  }
  const where = (file, line) => ({ file, line })
  for (const unit of units) {
    for (const file of unit.files) {
      const source = read(repoRoot, file)
      for (const imported of moduleImports(source, file)) {
        const target = resolveSpecifier(file, imported.specifier)
        if (!target) continue
        const normalised = normaliseModulePath(target)
        const owner = unitOfPath(normalised, units)
        if (owner === unit) continue
        if (owner) {
          if (unit.kind === 'plugin' && owner.kind === 'domain') {
            out.push(
              finding('fail', unit.id, 'plugin-imports-domain', {
                ...where(file, imported.line),
                problem: `imports '${imported.specifier}' from the app's domain '${owner.id}'`,
                fix:
                  'a plugin is installable in any app, so it cannot know this one’s domains — ' +
                  'offer an extension point (ServerPlugin.extensions) or an event the domain handles',
              })
            )
            continue
          }
          if (unit.kind === 'domain' && owner.kind === 'domain') {
            if (!unit.dependsOn.includes(owner.id)) {
              out.push(
                finding('fail', unit.id, 'undeclared-dependency', {
                  ...where(file, imported.line),
                  problem: `imports '${imported.specifier}' from the domain '${owner.id}', which its dependsOn does not list`,
                  fix: `add '${owner.id}' to dependsOn in apps/web/src/${unit.id}/index.ts — or, to react to something that happened there, handle its event instead`,
                })
              )
            }
            const schemaModule = normalised.startsWith(`apps/web/src/${owner.id}/db`)
            if (!isDomainPublicEntry(normalised, owner.id) && !schemaModule) {
              out.push(
                finding('fail', unit.id, 'internal-import', {
                  ...where(file, imported.line),
                  problem: `imports '${imported.specifier}', inside the domain '${owner.id}'`,
                  fix: `reach '${owner.id}' through '@/${owner.id}/public' (or its contracts, '@rocketflare/shared/${owner.id}/index'); add what you need to its public.ts`,
                })
              )
              continue
            }
          } else if (owner.kind === 'plugin' && !isPluginPublishedEntry(normalised, owner.id)) {
            // Plugin → plugin internals are `tests/config/plugins.test.ts`'s finding; a domain
            // reaching into a plugin is this one's.
            if (unit.kind === 'domain') {
              out.push(
                finding('fail', unit.id, 'internal-import', {
                  ...where(file, imported.line),
                  problem: `imports '${imported.specifier}', inside the plugin '${owner.id}'`,
                  fix: `reach a plugin only through its published entries ('@/plugins/${owner.id}', '@/plugins/${owner.id}/ui', its shared contracts)`,
                })
              )
              continue
            }
          }
          for (const name of imported.names) {
            const table = tableOf(normalised, name, owner)
            if (!table) continue
            out.push(
              finding('warn', unit.id, 'table-use', {
                ...where(file, imported.line),
                problem: `uses ${owner.kind === 'domain' ? 'the domain' : 'the plugin'} '${owner.id}'s table ${table} (${name}) directly`,
                fix:
                  `read and write it through '${owner.id}'s public functions` +
                  (owner.kind === 'domain' ? ` ('@/${owner.id}/public')` : '') +
                  ', so its own rules apply (access checks, row limits, invariants) and the edge ' +
                  "shows in the dependency graph. Direct writes are invisible to the owner's " +
                  'kill switch and to "exposes data from"',
              })
            )
          }
          continue
        }
        // Kit core. A domain reaches it only through the declared entries — the plugin rule.
        if (unit.kind !== 'domain') continue
        if (appListFiles.has(normalised)) {
          out.push(
            finding('fail', unit.id, 'kit-import', {
              ...where(file, imported.line),
              problem: `imports the app's unit list '${imported.specifier}'`,
              fix: 'a domain reaches another through its public.ts, never through the app lists',
            })
          )
          continue
        }
        if (isDeclared(normalised)) continue
        if (!HOST_ROOTS.some(root => normalised.startsWith(root))) continue
        out.push(
          finding('fail', unit.id, 'kit-import', {
            ...where(file, imported.line),
            problem: `imports '${imported.specifier}', a kit module that is not a declared entry`,
            fix: `replace with: ${suggestionFor(normalised)}`,
          })
        )
      }
    }
  }
  // Kit core never imports a domain except through the app's unit lists.
  const domainUnits = units.filter(u => u.kind === 'domain')
  if (domainUnits.length > 0) {
    const core = coreFiles ?? coreSourceFiles(repoRoot, units)
    for (const file of core) {
      if (appListFiles.has(normaliseModulePath(file))) continue
      for (const imported of moduleImports(read(repoRoot, file), file)) {
        const target = resolveSpecifier(file, imported.specifier)
        if (!target) continue
        const owner = unitOfPath(normaliseModulePath(target), domainUnits)
        if (!owner) continue
        out.push(
          finding('fail', owner.id, 'core-imports-domain', {
            ...where(file, imported.line),
            problem: `kit core imports '${imported.specifier}' from the domain '${owner.id}'`,
            fix: `wire the domain in ${APP_LISTS.web} (and its twins); core reads every domain through the unit list`,
          })
        )
      }
    }
  }
  return out
}

/** The extension a module path has on disk, or null. */
function fileFor(repoRoot, modulePath) {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = `${modulePath}${ext}`
    const abs = path.join(repoRoot, candidate)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate
  }
  return null
}

/** The kit's own source files (no unit's, no tests): what must never import a domain. */
export function coreSourceFiles(repoRoot, units) {
  return ['apps/web/src', 'packages/shared/src', 'apps/cli/src']
    .flatMap(dir => sourceFilesUnder(repoRoot, dir))
    .filter(f => !unitOfPath(f, units))
}

/** Everything: ids, edges, tables, imports. Sorted so two runs print the same list. */
export function unitFindings(repoRoot, { manifest = null, units = null } = {}) {
  const all = units ?? readUnits(repoRoot, { manifest })
  const out = [
    ...identityFindings(repoRoot, all),
    ...tableFindings(all),
    ...importFindings(repoRoot, all),
  ]
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.problem.localeCompare(b.problem)
  )
}

/**
 * What `pnpm plugin add` checks before copying a byte: the incoming plugin's id against the app's
 * domains and the reserved ids, and its declared tables against every domain's namespace. The
 * plugin's own manifest is all there is at that point — its files are not here yet.
 */
export function incomingPluginFindings(repoRoot, manifest, { kitManifest = null } = {}) {
  const out = []
  const id = manifest?.id
  if (typeof id !== 'string') return out
  const problem = unitIdProblem(id, 'plugin')
  if (problem && RESERVED_UNIT_IDS.includes(id)) {
    out.push(
      finding('fail', id, 'id', {
        file: 'rocketflare-plugin.json',
        problem,
        fix: 'a plugin cannot take a reserved id',
      })
    )
  }
  const domains = readUnits(repoRoot, { manifest: kitManifest }).filter(u => u.kind === 'domain')
  // The kit's own reference plugin, re-added from the kit, is an example like the domains.
  const incomingExample =
    normRepo(manifest?.repo) !== null &&
    normRepo(manifest?.repo) === normRepo(kitManifest?.kit?.repo)
  for (const d of domains) {
    if (d.id === id) {
      out.push(
        finding('fail', id, 'id-collision', {
          file: APP_LISTS.web,
          problem: `'${id}' is already a domain of this app`,
          fix: 'one id per unit — every namespace is keyed by it; rename the domain or do not install this plugin',
        })
      )
    }
    for (const table of manifest?.schema?.tables ?? []) {
      if (typeof table !== 'string' || (incomingExample && d.example)) continue
      if (d.definedTables.some(t => t.name === table) || inNamespace(d, table)) {
        out.push(
          finding('fail', id, 'table-namespace-collision', {
            file: `apps/web/src/${d.id}/index.ts`,
            problem: `the plugin's table ${table} is inside the domain '${d.id}'s namespace (${d.tables ? 'its tables list' : `'${d.tablePrefix}'`})`,
            fix: `give '${d.id}' an exact tables: [...] list in defineDomain, then add the plugin`,
          })
        )
      }
    }
  }
  return out
}
