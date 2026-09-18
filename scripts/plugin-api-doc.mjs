#!/usr/bin/env node
/**
 * Generate `docs/plugin-api.md` from the declared entries, and refuse a surface change that did
 * not bump `PLUGIN_API.current` (D31).
 *
 *     node scripts/plugin-api-doc.mjs            write the document
 *     node scripts/plugin-api-doc.mjs --check    exit 2 if it is out of date, write nothing
 *
 * **Why generated rather than written.** The document does three jobs a hand-written one cannot
 * keep doing past its first week:
 *
 * 1. **It enforces the version.** The committed document is the previous snapshot of the surface.
 *    A member that has changed or gone since, with `PLUGIN_API.current` still at the number the
 *    snapshot records, fails here — naming the member. That check is the only thing that makes the
 *    version mean anything: without it the number is a claim nobody verifies, which is the failure
 *    mode this whole piece of work exists to remove.
 * 2. **It attributes breaks.** Every member carries `used-by:` for the plugins installed in THIS
 *    checkout, derived from their imports. So the answer to "what does removing this cost" is in
 *    the file rather than in somebody's head. Only the reference plugin is installed in the kit, so
 *    nearly nothing is annotated — that is the honest answer for a kit with one plugin in it, and
 *    an unannotated member is not a dead one.
 * 3. **It is the discovery surface.** An agent writing a plugin should read one file, not infer a
 *    contract from 19 module paths and a hundred-odd symbols. Hence the capability index first:
 *    what you want to do, and the one name that does it.
 *
 * **A diff failure in CI means the document is stale, not that the gate is broken.** Run this
 * script and commit what it writes — the same contract as `apps/web/worker-configuration.d.ts`,
 * and it sits beside that step in `.github/workflows/gate.yml` for that reason.
 *
 * Exit codes: 0 ok · 1 error · 2 out of date (`--check`) · 3 a surface change needs a version bump.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = path.join(REPO_ROOT, 'docs/plugin-api.md')
const CONTRACT = 'packages/shared/src/plugins/contract.ts'

/**
 * The declared entries, in reading order: the server surface first, then the halves a plugin
 * reaches for less often.
 *
 * `import` is the specifier a plugin actually writes, which is the thing a reader needs — the
 * repo path is an implementation detail of this script. The CLI entries are relative because a
 * plugin's CLI half lives beside them and there is no alias for that package.
 */
const ENTRIES = [
  {
    import: '@/plugins/api',
    file: 'apps/web/src/plugins/api/index.ts',
    role: 'The server surface: the context family, and the types a plugin must be able to name.',
  },
  {
    import: '@/plugins/api/peers',
    file: 'apps/web/src/plugins/api/peers.ts',
    role: 'The two escape hatches that read the whole installed set. Not on the barrel, on purpose.',
  },
  {
    import: '@/plugins/api/ui-wiring',
    file: 'apps/web/src/plugins/api/ui-wiring.ts',
    role: "The only host module a plugin's `ui/index.ts` may import — it ships in the main bundle.",
  },
  {
    import: '@/plugins/api/ui',
    file: 'apps/web/src/plugins/api/ui.ts',
    role: 'Components and hooks, for a lazy PAGE. Never for the UI entry.',
  },
  {
    import: '@/plugins/types',
    file: 'apps/web/src/plugins/types.ts',
    role: '`ServerPlugin` and `UiPlugin` — the slots a plugin fills.',
  },
  {
    import: '@/db/schema/kit',
    file: 'apps/web/src/db/schema/kit.ts',
    role: 'The build-time schema symbols. A `pgTable(...)` runs at module scope, so these cannot be injected.',
  },
  {
    import: '@rocketflare/shared/plugins/api',
    file: 'packages/shared/src/plugins/api.ts',
    role: "What a plugin's CONTRACT module imports: the error envelope, pagination, `SharedPlugin`.",
  },
  {
    import: '@rocketflare/shared/plugins/contract',
    file: CONTRACT,
    role: 'The plugin API version itself.',
  },
  {
    import: "'../api' (apps/cli/src/plugins/api.ts)",
    file: 'apps/cli/src/plugins/api.ts',
    role: 'The CLI half: the one `fetch` site, the exit codes, the output helpers.',
  },
  {
    import: "'./types' (apps/cli/src/plugins/types.ts)",
    file: 'apps/cli/src/plugins/types.ts',
    role: '`CliPlugin` and the `action()` wrapper it registers with.',
  },
  {
    import: '@testkit/integration',
    file: 'apps/web/tests/kit/integration.ts',
    role: 'The harness: a real database, the real Hono app, real bindings-shaped stubs, the provider tree.',
  },
  {
    import: '@testkit/unit',
    file: 'apps/web/tests/kit/unit.ts',
    role: 'Builders for the context family, for tests that never touch data.',
  },
]

/**
 * Types whose MEMBERS are part of the contract, not just their names.
 *
 * Every execution context is here, because a context's members are the whole of what a plugin can
 * do — removing one is the break this document exists to catch, and a check that only watched
 * top-level exports would not see it. `/Ctx$/` covers the family; the rest are named because a
 * plugin fills them in (`ServerPlugin`), implements them (`CliPlugin`) or reads them every request
 * (`PluginAuth`).
 */
const EXPANDED = new Set([
  'PluginContext',
  'PluginAuth',
  'ServerPlugin',
  'UiPlugin',
  'SharedPlugin',
  'CliPlugin',
  'PluginRoute',
  'PluginNavGroup',
  'StepRealtime',
  'StepOptions',
])

const expands = name => EXPANDED.has(name) || /Ctx$/.test(name)

/**
 * The capability index — *what you want to do* → *the one name that does it*.
 *
 * Hand-written, because no extraction can know that "restrict a row to groups" means
 * `sharedWithMyGroups`. Pinned, because every `use` below must resolve to a member this script
 * extracted: a capability naming something that has been renamed fails the generator rather than
 * sending the next reader to a symbol that is not there.
 */
const CAPABILITIES = [
  ['Handle a request', 'requestCtx', '@/plugins/api'],
  ['Build a router, validate a body', 'createRouter', '@/plugins/api'],
  ['Check what a role may do', 'RequestCtx.guard', '@/plugins/api'],
  ['Check what a row-level reader may see', 'RequestCtx.scope', '@/plugins/api'],
  ['Check whether this deployment ships a surface', 'hasFeature', '@/plugins/api'],
  ['Gate a whole mount on a feature flag', 'requireFeature', '@/plugins/api'],
  ['Read a `:id` parameter safely', 'RequestCtx.uuid', '@/plugins/api'],
  ['Answer a paginated list', 'RequestCtx.page', '@/plugins/api'],
  ['Fail with the shared error envelope', 'RequestCtx.notFound', '@/plugins/api'],
  ['Run a side effect after the response', 'RequestCtx.defer', '@/plugins/api'],
  ['Enqueue a job', 'RequestCtx.enqueue', '@/plugins/api'],
  ['Handle a job', 'jobCtx', '@/plugins/api'],
  ['Run a scheduled task', 'cronCtx', '@/plugins/api'],
  ['Run a durable multi-step workflow', 'workflowCtx', '@/plugins/api'],
  ['Park a run until somebody answers', 'WorkflowCtx.waitForEvent', '@/plugins/api'],
  ['Tell open tabs a family of rows moved', 'RequestCtx.nudge', '@/plugins/api'],
  ['Notify one person', 'notify', '@/plugins/api'],
  ['Write to the audit log', 'recordActivity', '@/plugins/api'],
  ['Reach a per-tenant Durable Object', 'durableObject', '@/plugins/api'],
  ['Store or read a file', 'RequestCtx.storage', '@/plugins/api'],
  ['Write several rows as one transaction', 'transaction', '@/plugins/api'],
  ['Seed a new organisation', 'HookCtx', '@/plugins/api'],
  ['Add rows to `pnpm seed --demo`', 'SeedCtx', '@/plugins/api'],
  ['Give every agent run a tool', 'defineTool', '@/plugins/api'],
  ['Read what the run’s requester may read', 'ToolCtx', '@/plugins/api'],
  ['Write an agent', 'AgentCtx', '@/plugins/api'],
  ['Make a side effect happen once per run', 'AgentCtx.once', '@/plugins/api'],
  ['Ledger a model call', 'recordUsage', '@/plugins/api'],
  ['Trace a model call', 'withAgentTrace', '@/plugins/api'],
  ['Restrict a row to groups', 'sharedWithMyGroups', '@/plugins/api'],
  ['Escape a handler with a snapshot', 'RequestCtx.detached', '@/plugins/api'],
  ['Read what other plugins contributed', 'extensions', '@/plugins/api/peers'],
  ['Hand a library the whole schema', 'allTables', '@/plugins/api/peers'],
  ['Declare a tenant-scoped table', 'tenantRef', '@/db/schema/kit'],
  ['Give a table its RLS policy', 'tenantIsolation', '@/db/schema/kit'],
  ['Add a nav item and a route', 'UiPlugin', '@/plugins/types'],
  ['Guard a nav item on a flag', 'featureGuard', '@/plugins/api/ui-wiring'],
  ['Call the API from a page', 'api', '@/plugins/api/ui'],
  ['Declare contracts, jobs, subjects, flags', 'SharedPlugin', '@rocketflare/shared/plugins/api'],
  [
    'Answer a paginated list, in the contract',
    'paginatedResponse',
    '@rocketflare/shared/plugins/api',
  ],
  ['Add a CLI command', 'CliPlugin', "'./types' (apps/cli/src/plugins/types.ts)"],
  ['Call the API from a command', 'requireClient', "'../api' (apps/cli/src/plugins/api.ts)"],
  ['Prove tenant isolation', 'request', '@testkit/integration'],
  ['Build a fake request context', 'makeRequestCtx', '@testkit/unit'],
]

// ---- extraction --------------------------------------------------------------------------------

/**
 * One TypeScript program over every entry, and the checker only for RESOLVING re-exports.
 *
 * Signatures are printed from the declaration's own SYNTAX, never from `checker.typeToString` on
 * anything structural: that prints `import("/Users/…/db/client").Database` for a type it cannot
 * name, so the output would depend on where the repository is checked out — and a document whose
 * diff changes with the absolute path cannot be diff-checked in CI at all. The one place a type is
 * asked for is a `const` with no annotation, and the `import("…")` form is stripped there.
 */
function buildProgram() {
  const files = ENTRIES.map(e => path.join(REPO_ROOT, e.file))
  const globals = path.join(REPO_ROOT, 'apps/web/worker-configuration.d.ts')
  return ts.createProgram([...files, ...(existsSync(globals) ? [globals] : [])], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    noEmit: true,
    baseUrl: path.join(REPO_ROOT, 'apps/web'),
    paths: { '@/*': ['src/*'], '@testkit/*': ['tests/kit/*'] },
    types: ['node'],
  })
}

/** The longest a printed type may be before it is cut. Deterministic, so the ledger is stable. */
const TYPE_MAX = 300

/**
 * A drizzle table prints as several thousand characters of column metadata, and the part of that
 * which is actually a contract is the column NAMES — a plugin references `users.id`, never its
 * `driverParam`. So a table is summarised to its name and its columns: readable, and still enough
 * to fail the version check when a column a plugin could be pointing a foreign key at disappears.
 *
 * Everything else is cut at `TYPE_MAX`, and the cost is stated rather than hidden: a change beyond
 * that point is not caught. That is the price of a ledger somebody can read.
 */
function simplify(printed) {
  const table = summariseTable(printed)
  if (table) return table
  return printed.length <= TYPE_MAX ? printed : `${printed.slice(0, TYPE_MAX)}… (truncated)`
}

function summariseTable(printed) {
  if (!printed.startsWith('PgTableWithColumns<')) return null
  const name = printed.match(/name:\s*"([^"]+)"/)
  const at = printed.indexOf('columns: {')
  if (!name || at === -1) return null
  const columns = topLevelKeys(printed.slice(at + 'columns: '.length))
  return `table "${name[1]}" { ${columns.join(', ')} }`
}

/** The keys of the OUTERMOST object in `text`, with every nested one skipped. */
function topLevelKeys(text) {
  let depth = 0
  let flat = ''
  for (const ch of text) {
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth === 1) flat += ch
  }
  return [...flat.matchAll(/(?:^|;)\s*([A-Za-z_$][\w$]*)\s*:/g)].map(m => m[1])
}

/**
 * Refuse to run against a checkout whose dependencies are not installed.
 *
 * Without `node_modules` the compiler resolves neither `zod` nor `drizzle-orm` nor `hono`, and
 * every inferred type degrades silently to `any` — so the document generates CLEANLY and records a
 * surface that is wrong. The next person to run it with dependencies present then gets a diff on a
 * dozen members and an instruction to bump the version for a change nobody made. A generated
 * artefact that is diff-checked has to be a function of its source alone, and this is the one
 * input that quietly was not.
 */
function assertResolvable(program) {
  if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    throw new Error(
      'node_modules is missing — run `pnpm install` first, or every type reads as `any`'
    )
  }
  const unresolved = new Set()
  for (const entry of ENTRIES) {
    const source = program.getSourceFile(path.join(REPO_ROOT, entry.file))
    if (!source) continue
    for (const d of program.getSemanticDiagnostics(source)) {
      if (d.code === 2307) unresolved.add(ts.flattenDiagnosticMessageText(d.messageText, ' '))
    }
  }
  if (unresolved.size > 0) {
    const list = [...unresolved].join('\n  ')
    throw new Error(
      `the declared entries do not resolve, so every inferred type is wrong:\n  ${list}`
    )
  }
}

/** Collapse a declaration to one line: no comments, no runs of whitespace, no trailing punctuation. */
function oneLine(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[;,]\s*$/, '')
    .trim()
}

/** `import("/abs/path").Foo` → `Foo`. The only machine-dependent thing a type string can carry. */
function stripImportPaths(text) {
  return text.replace(/import\("[^"]*"\)\./g, '')
}

/** The first paragraph of a doc comment, on one line, capped so a table stays a table. */
function summarise(text) {
  const first = (text ?? '').split(/\n\s*\n/)[0] ?? ''
  const line = first.replace(/\s+/g, ' ').trim()
  if (line.length <= 180) return line
  const cut = line.slice(0, 180)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

function docOf(checker, symbol, alias) {
  const own = summarise(ts.displayPartsToString(symbol.getDocumentationComment(checker)))
  if (own) return own
  return alias ? summarise(ts.displayPartsToString(alias.getDocumentationComment(checker))) : ''
}

/** The kind word and the printed signature for one declaration. */
function describe(checker, symbol, declaration) {
  const d = declaration
  if (ts.isInterfaceDeclaration(d)) {
    const head = d.heritageClauses?.map(h => oneLine(h.getText())).join(' ') ?? ''
    const params = d.typeParameters
      ? `<${d.typeParameters.map(p => oneLine(p.getText())).join(', ')}>`
      : ''
    return { kind: 'interface', signature: oneLine(`interface ${d.name.text}${params} ${head}`) }
  }
  if (ts.isTypeAliasDeclaration(d)) {
    return { kind: 'type', signature: oneLine(`type ${d.name.text} = ${d.type.getText()}`) }
  }
  if (ts.isClassDeclaration(d) && d.name) {
    const head = d.heritageClauses?.map(h => oneLine(h.getText())).join(' ') ?? ''
    return { kind: 'class', signature: oneLine(`class ${d.name.text} ${head}`) }
  }
  if (ts.isFunctionDeclaration(d) && d.name) {
    const text = d.body ? d.getText().slice(0, d.body.getStart() - d.getStart()) : d.getText()
    return { kind: 'function', signature: oneLine(text.replace(/^export\s+/, '')) }
  }
  if (ts.isEnumDeclaration(d)) return { kind: 'enum', signature: `enum ${d.name.text}` }
  if (ts.isVariableDeclaration(d)) {
    const name = d.name.getText()
    if (d.type) return { kind: 'const', signature: oneLine(`const ${name}: ${d.type.getText()}`) }
    const type = checker.getTypeOfSymbolAtLocation(symbol, d)
    const printed = checker.typeToString(type, d, ts.TypeFormatFlags.NoTruncation)
    return {
      kind: 'const',
      signature: oneLine(`const ${name}: ${simplify(stripImportPaths(printed))}`),
    }
  }
  return { kind: 'value', signature: symbol.getName() }
}

/** The members of an expanded type, in declaration order — the order a reader met them in. */
function membersOf(checker, declaration) {
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) return []
  return declaration.members
    .filter(m => m.name || ts.isCallSignatureDeclaration(m) || ts.isIndexSignatureDeclaration(m))
    .map(m => {
      const symbol = checker.getSymbolAtLocation(m.name ?? m)
      const doc = symbol
        ? summarise(ts.displayPartsToString(symbol.getDocumentationComment(checker)))
        : ''
      return { name: m.name ? m.name.getText() : '()', signature: oneLine(m.getText()), doc }
    })
}

/** Every exported member of every entry, sorted by name so the document is stable. */
function extract() {
  const program = buildProgram()
  assertResolvable(program)
  const checker = program.getTypeChecker()
  const out = []
  for (const entry of ENTRIES) {
    const source = program.getSourceFile(path.join(REPO_ROOT, entry.file))
    if (!source) throw new Error(`entry not found: ${entry.file}`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    if (!moduleSymbol) throw new Error(`no module symbol: ${entry.file}`)
    const members = []
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const alias = exported.flags & ts.SymbolFlags.Alias ? exported : null
      const symbol = alias ? checker.getAliasedSymbol(alias) : exported
      const declaration = symbol.declarations?.[0]
      if (!declaration) continue
      const { kind, signature } = describe(checker, symbol, declaration)
      const name = exported.getName()
      members.push({
        name,
        kind,
        signature,
        doc: docOf(checker, symbol, alias),
        members: expands(name) ? membersOf(checker, declaration) : [],
      })
    }
    members.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    out.push({ ...entry, members, intro: fileIntro(source) })
  }
  return out
}

/** The first paragraph of the module's own header comment — the sentence it opens with. */
function fileIntro(source) {
  const text = source.getFullText()
  const match = text.match(/^\/\*\*([\s\S]*?)\*\//)
  if (!match) return ''
  const body = match[1]
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
  return summarise(body)
}

// ---- who uses what -----------------------------------------------------------------------------

const PLUGIN_ROOTS = [
  'apps/web/src/plugins/',
  'packages/shared/src/plugins/',
  'apps/cli/src/plugins/',
]
const RESERVED = new Set(['index', 'server', 'ui', 'schema', 'types', 'api', 'contract'])

function pluginIdOf(repoPath) {
  for (const root of PLUGIN_ROOTS) {
    if (!repoPath.startsWith(root)) continue
    const id = (repoPath.slice(root.length).split('/')[0] ?? '').replace(/\.(tsx?|jsx?)$/, '')
    if (!id || id.includes('.') || RESERVED.has(id)) return null
    return id
  }
  return null
}

/**
 * `plugin id → the names it imports from an entry`, for the `used-by:` annotations.
 *
 * Only what an installed plugin NAMES in an import, which is why an interface member never carries
 * one: there is no import to observe. That is a limit of the method rather than a claim about the
 * member, and the document says so where the annotations are.
 */
function usedBy(entries) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter(f => /\.(tsx?|jsx?)$/.test(f) && pluginIdOf(f) && existsSync(path.join(REPO_ROOT, f)))

  const byEntry = new Map(entries.map(e => [e.import, new Map()]))
  const alias = specifier => {
    if (specifier === '@/plugins/api' || specifier.startsWith('@/plugins/api/')) {
      return [
        '@/plugins/api',
        '@/plugins/api/peers',
        '@/plugins/api/ui',
        '@/plugins/api/ui-wiring',
      ].includes(specifier)
        ? specifier
        : null
    }
    if (specifier === '@/plugins/types') return '@/plugins/types'
    if (specifier === '@/db/schema/kit') return '@/db/schema/kit'
    if (specifier === '@rocketflare/shared/plugins/api') return '@rocketflare/shared/plugins/api'
    if (specifier === '@rocketflare/shared/plugins/contract') {
      return '@rocketflare/shared/plugins/contract'
    }
    if (/(^|\/)\.\.?\/api$/.test(specifier) || specifier === '../api') {
      return "'../api' (apps/cli/src/plugins/api.ts)"
    }
    if (specifier === './types' || specifier === '../types') {
      return "'./types' (apps/cli/src/plugins/types.ts)"
    }
    if (specifier === '@testkit/integration') return '@testkit/integration'
    if (specifier === '@testkit/unit') return '@testkit/unit'
    return null
  }

  for (const file of files) {
    const id = pluginIdOf(file)
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const entry = alias(node.moduleSpecifier.text)
        const bindings = node.importClause?.namedBindings
        if (entry && bindings && ts.isNamedImports(bindings)) {
          const map = byEntry.get(entry)
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text
            if (!map.has(name)) map.set(name, new Set())
            map.get(name).add(id)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return byEntry
}

// ---- the ledger --------------------------------------------------------------------------------

const LEDGER_FENCE = '```text'

/** `entry :: kind :: name :: signature`, one line per member. ` :: ` because TypeScript has none. */
function ledgerLines(entries) {
  const lines = []
  for (const entry of entries) {
    for (const member of entry.members) {
      lines.push(`${entry.import} :: ${member.kind} :: ${member.name} :: ${member.signature}`)
      for (const inner of member.members) {
        const name = `${member.name}.${inner.name}`
        lines.push(`${entry.import} :: member :: ${name} :: ${inner.signature}`)
      }
    }
  }
  return lines
}

/** The committed document's snapshot: its version, and every member it recorded. */
function parseLedger(markdown) {
  const start = markdown.indexOf('## Surface ledger')
  if (start === -1) return null
  const fence = markdown.indexOf(LEDGER_FENCE, start)
  if (fence === -1) return null
  const body = markdown.slice(fence + LEDGER_FENCE.length)
  const end = body.indexOf('```')
  const lines = body
    .slice(0, end === -1 ? undefined : end)
    .split('\n')
    .map(l => l.trim())
  const header = lines.find(l => l.startsWith('plugin-api '))
  const version = header ? Number.parseInt(header.slice('plugin-api '.length), 10) : null
  const members = new Map()
  for (const line of lines) {
    const parts = line.split(' :: ')
    if (parts.length < 4) continue
    const [entry, kind, name] = parts
    members.set(`${entry} :: ${name}`, { kind, signature: parts.slice(3).join(' :: ') })
  }
  return { version, members }
}

/**
 * What changed since the committed snapshot, and whether the version covers it.
 *
 * Additions are free at the same version — a plugin written against version N still compiles
 * against N plus one more method, which is the whole reason the number is not bumped per commit.
 * A change or a removal is not free, and neither is silent: both name the member.
 */
function surfaceChanges(previous, entries) {
  if (!previous) return { changed: [], removed: [] }
  const next = new Map()
  for (const line of ledgerLines(entries)) {
    const parts = line.split(' :: ')
    next.set(`${parts[0]} :: ${parts[2]}`, parts.slice(3).join(' :: '))
  }
  const changed = []
  const removed = []
  for (const [key, recorded] of previous.members) {
    const now = next.get(key)
    if (now === undefined) removed.push(key)
    else if (now !== recorded.signature)
      changed.push({ key, before: recorded.signature, after: now })
  }
  return { changed, removed }
}

// ---- rendering ---------------------------------------------------------------------------------

/** `|` in a signature would end a markdown table cell, so a code span carries it escaped. */
const cell = text => `\`${text.replace(/\|/g, '\\|')}\``

function renderHeader(api) {
  return `# The plugin API

**Generated. Do not edit.** \`node scripts/plugin-api-doc.mjs\` writes this file from the source of
the declared entries, and \`.github/workflows/gate.yml\` regenerates it and diffs it — beside the
step that does the same for \`apps/web/worker-configuration.d.ts\`, and for the same reason: a
generated artefact that is committed and diff-checked cannot drift from its source. **A diff
failure means this file is stale. Run the script and commit what it writes.**

Two other failures come out of the same script and mean something different:

- *"changed without a bump"* — a member's signature moved, or the member is gone, while
  \`PLUGIN_API.current\` still reads ${api.current}. Either restore the member, or raise
  \`current\` in \`${CONTRACT}\` and mirror it in
  \`.rocketflare.json\`. The script names the member.
- *"capability names a member that does not exist"* — the index at the top points at a symbol that
  has been renamed. Fix the index in the generator; a capability index nobody maintains is worse
  than none, because it sends the next reader to a name that is not there.

This is the whole of what a plugin may import from the host. The rule the entries make true is one
sentence: **a plugin imports only from declared entries, and receives everything else as injected
context** (\`apps/web/tests/helpers/plugins.ts\` enforces it, and every diagnostic it prints carries
the replacement import). Anything not listed here is a kit internal: reaching for it is what makes a
plugin's own version number meaningless, because the plugin is then pinned to something nobody
promised to keep.
`
}

function renderCapabilities(entries) {
  const known = new Set()
  for (const entry of entries) {
    for (const member of entry.members) {
      known.add(`${entry.import} :: ${member.name}`)
      for (const inner of member.members)
        known.add(`${entry.import} :: ${member.name}.${inner.name}`)
    }
  }
  const missing = CAPABILITIES.filter(([, use, entry]) => !known.has(`${entry} :: ${use}`))
  if (missing.length > 0) {
    const names = missing.map(([want, use]) => `${use} (${want})`).join(', ')
    throw Object.assign(new Error(`capability index names members that do not exist: ${names}`), {
      exitCode: 1,
    })
  }
  const rows = CAPABILITIES.map(
    ([want, use, entry]) => `| ${want} | ${cell(use)} | ${cell(entry)} |`
  )
  return `## What you want to do

Read this first. It is the index the rest of the file is the reference for — one line per thing a
plugin actually does, and the single name that does it. Every entry below is checked to exist, so a
name here is a name you can import today.

| To… | Use | From |
|---|---|---|
${rows.join('\n')}
`
}

function renderVersion(api) {
  return `## The plugin API version

\`\`\`
current       ${api.current}
minSupported  ${api.minSupported}
\`\`\`

A plugin declares \`requires.pluginApi\` in its own \`plugin.json\` — **a whole number, never a
range**:

\`\`\`json
"requires": { "kit": ">=0.6.0 <1.0.0", "pluginApi": "${api.current}" }
\`\`\`

**It is not \`requires.kit\`, and merging the two is the bug this replaces.** \`requires.kit\` says
which kit RELEASES a plugin may be installed into; this says which version of the SURFACE above it
was written against. The kit cut three releases without the surface moving at all, and a plugin
pinned only by kit range had to be re-released for each — so every pin became a guess, and the
guesses drifted.

The comparison is integer and lives in one place, \`scripts/lib/plugin-api.mjs\`:

- declared > \`current\` — the plugin needs a newer kit.
- declared < \`minSupported\` — the plugin needs migrating to the current contract.
- **not declared at all — warned, never refused.** A plugin released before this existed cannot
  retroactively declare anything, and refusing it would break installs of plugins nobody can
  change. Declaring the version is what moves a plugin from *warned* to *checked*, and it happens
  in the release that migrates it.

There is deliberately no range language anywhere near this number. A malformed semver range throws
out of the matcher and reaches the caller as a generic failure with nothing to act on; an integer
has one way to be wrong and one sentence to say so.
`
}

function renderEntry(entry, used) {
  const lines = [`### \`${entry.import}\``, '', entry.role, '']
  if (entry.intro) lines.push(`> ${entry.intro}`, '')
  for (const member of entry.members) {
    const who = used.get(member.name)
    const tail = who ? ` — **used by** ${[...who].sort().join(', ')}` : ''
    lines.push(`- ${cell(member.signature)}${tail}`)
    if (member.doc) lines.push(`  ${member.doc}`)
    for (const inner of member.members) {
      lines.push(`  - ${cell(inner.signature)}`)
      if (inner.doc) lines.push(`    ${inner.doc}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function renderUsedBy(entries, usage) {
  const rows = []
  for (const entry of entries) {
    const used = usage.get(entry.import)
    for (const [name, ids] of [...used.entries()].sort()) {
      rows.push(`| ${cell(name)} | ${cell(entry.import)} | ${[...ids].sort().join(', ')} |`)
    }
  }
  if (rows.length === 0) {
    return `## Who uses what

No installed plugin names anything from these entries. That is the honest answer for this checkout
rather than a defect, and it is what the annotations exist to say when it stops being true.
`
  }
  return `## Who uses what

Derived from the imports of the plugins installed **in this checkout** — so it answers "what does
removing this cost" for this app, and it changes when somebody installs a plugin. An unannotated
member is not a dead one: only the reference plugin ships with the kit, so most of the surface has
no user here and never will have until an app installs something that needs it. Interface members
carry no annotation at all, because there is no import to observe.

| Member | Entry | Used by |
|---|---|---|
${rows.join('\n')}
`
}

function renderLedger(entries, api) {
  return `## Surface ledger

The machine-readable snapshot, and the only part of this file the generator reads back. Every
member is one line; the version is the number the snapshot was taken at. A change or a removal
below with that number unchanged is what fails the gate, which is the whole mechanism by which the
version means something rather than being a claim.

${LEDGER_FENCE}
plugin-api ${api.current}
${ledgerLines(entries).join('\n')}
\`\`\`
`
}

function render(entries, api, usage) {
  const parts = [
    renderHeader(api),
    renderCapabilities(entries),
    renderVersion(api),
    '## The entries\n\nOne section per declared entry. A nested list under a type is its own members: those are part\nof the contract too, and removing one is a break the ledger catches.\n',
    ...entries.map(e => renderEntry(e, usage.get(e.import))),
    renderUsedBy(entries, usage),
    renderLedger(entries, api),
  ]
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

// ---- the version, from the one source and its mirror ---------------------------------------------

/**
 * `PLUGIN_API` read out of the TypeScript leaf by parsing it.
 *
 * Parsed rather than imported because this script is plain Node and the constant is a `.ts` file —
 * the same reason `.rocketflare.json` carries the mirror at all. The mirror is not read here on
 * purpose: the TypeScript file is the source, and `apps/web/tests/config/plugin-api.test.ts` is
 * what proves the two agree.
 */
function readPluginApiSource() {
  const text = readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf8')
  const current = text.match(/current:\s*(\d+)/)
  const minSupported = text.match(/minSupported:\s*(\d+)/)
  if (!current || !minSupported) throw new Error(`cannot read PLUGIN_API from ${CONTRACT}`)
  return {
    current: Number.parseInt(current[1], 10),
    minSupported: Number.parseInt(minSupported[1], 10),
  }
}

// ---- main --------------------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes('--check')
  const api = readPluginApiSource()
  const entries = extract()
  const usage = usedBy(entries)
  const previous = existsSync(DOC_PATH) ? parseLedger(readFileSync(DOC_PATH, 'utf8')) : null

  if (previous?.version !== null && previous !== null && previous.version > api.current) {
    console.error(
      `✖ docs/plugin-api.md records plugin API ${previous.version}, but ${CONTRACT} says ` +
        `${api.current}. The version only ever goes up.`
    )
    return 3
  }

  const { changed, removed } = surfaceChanges(previous, entries)
  if ((changed.length > 0 || removed.length > 0) && previous.version === api.current) {
    console.error(
      `✖ the plugin API surface changed, but PLUGIN_API.current is still ${api.current}.\n` +
        `  Raise it in ${CONTRACT} and mirror it in .rocketflare.json, or restore what moved.\n`
    )
    for (const key of removed) console.error(`  removed  ${key}`)
    for (const c of changed) {
      console.error(
        `  changed  ${c.key}\n             was: ${c.before}\n             now: ${c.after}`
      )
    }
    console.error(
      '\n  A plugin written against this version compiles against the surface it was given. ' +
        'Additions are free; these are not.'
    )
    return 3
  }

  const markdown = render(entries, api, usage)
  const existing = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : null
  if (check) {
    if (existing === markdown) {
      console.log(`✔ docs/plugin-api.md is up to date (plugin API ${api.current})`)
      return 0
    }
    console.error('✖ docs/plugin-api.md is out of date — run `node scripts/plugin-api-doc.mjs`')
    return 2
  }
  if (existing !== markdown) {
    writeFileSync(DOC_PATH, markdown)
    console.log(`✔ wrote docs/plugin-api.md (plugin API ${api.current})`)
  } else {
    console.log(`✔ docs/plugin-api.md is up to date (plugin API ${api.current})`)
  }
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`✖ ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
