/**
 * The kit's plugin surface, MEASURED from the declared entries' source: what
 * `scripts/plugin-api-doc.mjs` writes to `docs/plugin-surface.json` (and, for one more release, to
 * the Markdown ledger), and what `readLedger` in `surface.mjs` reads back.
 *
 * Kept apart from `surface.mjs` because that module is vendored into plugin repositories and must
 * work with no `node_modules`; this one needs a parser. The parsing itself is
 * `module-exports.mjs`, which knows nothing about plugins — so a boundary check over some other set
 * of published entries reuses it rather than this file.
 */

import { createExportReader } from './module-exports.mjs'
import {
  LEDGER_ENTRIES,
  resolveSpecifier,
  SURFACE_ALIASES,
  SURFACE_JSON,
  SURFACE_SCHEMA_VERSION,
} from './surface.mjs'

export { SURFACE_JSON }

/**
 * One sentence per declared entry, saying what it is for. The LIST is `LEDGER_ENTRIES` in
 * `surface.mjs`, because an entry's label is the ledger's KEY; this is only the prose.
 */
export const ENTRY_ROLES = {
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

/**
 * Types whose MEMBERS are part of the contract, not just their names.
 *
 * Every execution context is here, because a context's members are the whole of what a plugin can
 * do — removing one is the break the surface exists to catch, and a check that only watched
 * top-level exports would not see it. `/Ctx$/` covers the family; the rest are named because a
 * plugin fills them in (`ServerPlugin`), implements them (`CliPlugin`) or reads them every request
 * (`PluginAuth`). Only an INTERFACE expands: a type alias's members are not syntax to list.
 */
export const EXPANDED = new Set([
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
  'BackgroundMethods',
  'StartAgentRunInput',
  'StartedAgentRun',
])

export const expands = name => EXPANDED.has(name) || /Ctx$/.test(name)

/**
 * `{ entries, members, moved, aliases }` for the declared entries of the repository at `repoRoot`.
 *
 * `members` is in ledger order — entries as `LEDGER_ENTRIES` lists them, each entry's exports by
 * name, an expanded interface's own members straight after it — and deduplicated on
 * `entry :: name`. `moved` maps every name to the entries that provide it, in the same order: a
 * symbol a plugin names under one entry and finds missing there is suggested from the first other.
 */
export function readDeclaredSurface(repoRoot, { entries = LEDGER_ENTRIES } = {}) {
  const reader = createExportReader({ repoRoot, resolve: resolveSpecifier })
  const members = []
  const seen = new Set()
  const add = (entry, kind, name) => {
    const key = `${entry} :: ${name}`
    if (seen.has(key)) return
    seen.add(key)
    members.push({ entry, kind, name })
  }
  for (const entry of entries) {
    for (const exported of reader.exportsOf(entry.file)) {
      add(entry.import, exported.kind, exported.name)
      if (exported.kind === 'interface' && expands(exported.name)) {
        for (const inner of exported.members)
          add(entry.import, 'member', `${exported.name}.${inner}`)
      }
    }
  }
  const moved = {}
  for (const m of members) {
    if (!moved[m.name]) moved[m.name] = []
    moved[m.name].push(m.entry)
  }
  const sortedMoved = {}
  for (const name of Object.keys(moved).sort((a, b) => a.localeCompare(b, 'en'))) {
    sortedMoved[name] = moved[name]
  }
  return {
    entries: entries.map(e => ({
      import: e.import,
      file: e.file,
      role: ENTRY_ROLES[e.import] ?? '',
    })),
    members,
    moved: sortedMoved,
    aliases: { ...SURFACE_ALIASES },
  }
}

/**
 * The JSON, written one member per line so a diff names the member that changed. The shape is
 * what `readLedger` validates; `schemaVersion` changes only when a reader would misread it.
 */
export function renderSurfaceJson(surface) {
  const q = JSON.stringify
  const entries = surface.entries.map(e => `    { "import": ${q(e.import)}, "file": ${q(e.file)} }`)
  const members = surface.members.map(
    m => `    { "entry": ${q(m.entry)}, "kind": ${q(m.kind)}, "name": ${q(m.name)} }`
  )
  const aliases = Object.entries(surface.aliases).map(([from, to]) => `    ${q(from)}: ${q(to)}`)
  const moved = Object.entries(surface.moved).map(
    ([name, where]) => `    ${q(name)}: [${where.map(w => q(w)).join(', ')}]`
  )
  return `{
  "generatedBy": "node scripts/plugin-api-doc.mjs",
  "schemaVersion": ${SURFACE_SCHEMA_VERSION},
  "aliases": {
${aliases.join(',\n')}
  },
  "entries": [
${entries.join(',\n')}
  ],
  "members": [
${members.join(',\n')}
  ],
  "moved": {
${moved.join(',\n')}
  }
}
`
}
