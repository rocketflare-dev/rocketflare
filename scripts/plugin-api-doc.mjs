#!/usr/bin/env node
/**
 * Generate `docs/plugin-api.md` from the declared entries (D31).
 *
 *     node scripts/plugin-api-doc.mjs            write the document
 *     node scripts/plugin-api-doc.mjs --check    exit 2 if it is out of date, write nothing
 *
 * **Why generated rather than written.** The document does two jobs a hand-written one cannot keep
 * doing past its first week:
 *
 * 1. **It is the discovery surface.** An agent writing a plugin should read one file, not infer a
 *    contract from a dozen module paths and several hundred symbols. Hence the capability index
 *    first: what you want to do, and the one name that does it. Every entry in that index is
 *    checked to exist, because an index nobody maintains is worse than none — it sends the next
 *    reader to a name that is not there.
 * 2. **It emits the LEDGER.** The fenced block at the end is the machine-readable half: one line
 *    per member the kit provides. It is what makes compatibility an OBSERVATION rather than a
 *    prediction — a plugin's use is derived from its own imports and the answer is the set
 *    difference `uses \ ledger` (`scripts/lib/surface.mjs`). Nothing here asks anybody to declare
 *    a number, and nothing here can throw.
 *
 * **A diff failure in CI means the document is stale, not that the gate is broken.** Run this
 * script and commit what it writes — the same contract as `apps/web/worker-configuration.d.ts`,
 * and it sits beside that step in `.github/workflows/gate.yml` for that reason.
 *
 * Exit codes: 0 ok · 1 error · 2 out of date (`--check`).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { LEDGER_ENTRIES } from './lib/surface.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = path.join(REPO_ROOT, 'docs/plugin-api.md')

/**
 * One sentence per declared entry, saying what it is for.
 *
 * **The LIST itself is `LEDGER_ENTRIES` in `scripts/lib/surface.mjs`**, because an entry's label is
 * the ledger's KEY: it is what a plugin's measured imports are counted under, so a second copy of
 * it here would be exactly the duplication-drift this document exists to remove. What lives in
 * this file is only the prose, which nothing reads back.
 */
const ROLES = {
  '@/plugins/api':
    'The server surface: the context family, and the types a plugin must be able to name.',
  '@/plugins/api/peers':
    'The two escape hatches that read the whole installed set. Not on the barrel, on purpose.',
  '@/plugins/api/ui-wiring':
    "The only host module a plugin's `ui/index.ts` may import — it ships in the main bundle.",
  '@/plugins/api/ui': 'Components and hooks, for a lazy PAGE. Never for the UI entry.',
  '@/plugins/types': '`ServerPlugin` and `UiPlugin` — the slots a plugin fills.',
  '@/db/schema/kit':
    'The build-time schema symbols. A `pgTable(...)` runs at module scope, so these cannot be injected.',
  '@rocketflare/shared/plugins/api':
    "What a plugin's CONTRACT module imports: the error envelope, pagination, `SharedPlugin`.",
  "'../api' (apps/cli/src/plugins/api.ts)":
    'The CLI half: the one `fetch` site, the exit codes, the output helpers.',
  "'./types' (apps/cli/src/plugins/types.ts)":
    '`CliPlugin` and the `action()` wrapper it registers with.',
  '@testkit/integration':
    'The harness: a real database, the real Hono app, real bindings-shaped stubs, the provider tree.',
  '@testkit/unit': 'Builders for the context family, for tests that never touch data.',
}

const ENTRIES = LEDGER_ENTRIES.map(entry => ({ ...entry, role: ROLES[entry.import] ?? '' }))

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
  'RequestVisibility',
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
  ['Read or write who may see a row', 'RequestCtx.visibility', '@/plugins/api'],
  ['Read the reader’s groups and their types', 'RequestCtx.groups', '@/plugins/api'],
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
  ['Prove a cron task is dispatched', 'dispatchScheduled', '@testkit/integration'],
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

// ---- rendering ---------------------------------------------------------------------------------

/** `|` in a signature would end a markdown table cell, so a code span carries it escaped. */
const cell = text => `\`${text.replace(/\|/g, '\\|')}\``

function renderHeader() {
  return `# The plugin API

**Generated. Do not edit.** \`node scripts/plugin-api-doc.mjs\` writes this file from the source of
the declared entries, and \`.github/workflows/gate.yml\` regenerates it and diffs it — beside the
step that does the same for \`apps/web/worker-configuration.d.ts\`, and for the same reason: a
generated artefact that is committed and diff-checked cannot drift from its source. **A diff
failure means this file is stale. Run the script and commit what it writes.**

One other failure comes out of the same script and means something different:

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

function renderEntry(entry) {
  const lines = [`### \`${entry.import}\``, '', entry.role, '']
  if (entry.intro) lines.push(`> ${entry.intro}`, '')
  for (const member of entry.members) {
    lines.push(`- ${cell(member.signature)}`)
    if (member.doc) lines.push(`  ${member.doc}`)
    for (const inner of member.members) {
      lines.push(`  - ${cell(inner.signature)}`)
      if (inner.doc) lines.push(`    ${inner.doc}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function renderLedger(entries) {
  return `## Surface ledger

The machine-readable half of this file: one line per member the kit provides,
\`entry :: kind :: name :: signature\`.

**It is one side of a set difference.** What a plugin USES is derived from its own imports rather
than declared by its author (\`usesOf\` in \`scripts/lib/surface.mjs\`), and whatever it names that
this block does not carry is what fails an install — symbol by symbol, with the replacement import
where the symbol has merely moved entry. So there is no version to predict, no range to parse, and
nothing in the comparison that can throw.

${LEDGER_FENCE}
${ledgerLines(entries).join('\n')}
\`\`\`
`
}

function render(entries) {
  const parts = [
    renderHeader(),
    renderCapabilities(entries),
    '## The entries\n\nOne section per declared entry. A nested list under a type is its own members: those are part\nof the contract too, and removing one is a break the ledger catches.\n',
    ...entries.map(e => renderEntry(e)),
    renderLedger(entries),
  ]
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

// ---- main --------------------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes('--check')
  const entries = extract()
  const markdown = render(entries)
  const existing = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : null
  const members = ledgerLines(entries).length

  if (check) {
    if (existing === markdown) {
      console.log(`✔ docs/plugin-api.md is up to date (${members} members)`)
      return 0
    }
    console.error('✖ docs/plugin-api.md is out of date — run `node scripts/plugin-api-doc.mjs`')
    return 2
  }
  if (existing !== markdown) {
    writeFileSync(DOC_PATH, markdown)
    console.log(`✔ wrote docs/plugin-api.md (${members} members)`)
  } else {
    console.log(`✔ docs/plugin-api.md is up to date (${members} members)`)
  }
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`✖ ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
