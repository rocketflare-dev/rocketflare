/**
 * The pure half of `scripts/plugin.mjs` (D31, Phase B): the plugin id rules, the six barrel
 * lines, the file-root classification, the requirement check, the surface builder and the plan
 * text. No I/O and nothing runs at import time, so `apps/web/tests/config/plugin-lib.test.ts` can
 * drive every rule against a FIXTURE — which matters because most of them are rules about a plugin
 * this checkout does not have installed.
 *
 * The barrel writer is the part to read twice. Installing a plugin IS six lines; if this file
 * writes them differently from the way a person would, every install produces a lint diff and the
 * gate stops passing by construction. So it inserts in sorted order, it is idempotent (running
 * `add` twice writes nothing), and `remove` is its exact inverse — the test asserts the round trip
 * returns the original bytes.
 *
 * `plugin-lib.d.mts` beside this file is the hand-written type surface (no `allowJs`).
 */
import { KIT } from './rename-lib.mjs'
import { missingFrom } from './surface.mjs'
import { compareVersions, isVendored } from './upgrade-lib.mjs'

/**
 * A bare `X.Y.Z`, and nothing that resembles a range.
 *
 * **There is no range language anywhere in this file and there must never be one again.** A
 * malformed semver range threw out of the matcher and arrived at the caller as a generic failure
 * with nothing to act on — the exact shape of bug observed compatibility removes. A floor has one
 * way to be wrong, one comparison (`compareVersions`) and one sentence to say so.
 */
const BARE_VERSION = /^\d+\.\d+\.\d+$/

// ---------------------------------------------------------------- identity

/** The same rule `@rocketflare/shared/plugins` enforces at the type level. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/

/**
 * Barrel FILENAMES. An id that collides with one makes `./<id>` ambiguous with a barrel import —
 * and worse, `apps/web/src/plugins/<name>.ts` would then read as the entry of a plugin called
 * `<name>` to every rule that derives a plugin id from a path. Add a barrel, add its stem here.
 */
export const RESERVED_PLUGIN_IDS = Object.freeze([
  'index',
  'server',
  'ui',
  'schema',
  'types',
  'worker-exports',
])

/** `null` when `id` is a legal plugin id, else the sentence saying why it is not. */
export function pluginIdProblem(id) {
  if (typeof id !== 'string' || id === '') return 'a plugin id is required'
  if (!PLUGIN_ID_RE.test(id)) return `'${id}' must match ${PLUGIN_ID_RE.source}`
  // The rename translator rewrites the kit's name everywhere; an id carrying it would be rewritten
  // along with everything else, and the plugin would arrive under a name nothing imports.
  if (id.includes(KIT.slug)) return `'${id}' must not contain the kit's name`
  if (RESERVED_PLUGIN_IDS.includes(id)) return `'${id}' is a barrel filename`
  return null
}

/** `example-feature` → `exampleFeature`. The stem of every barrel export name. */
export function camelId(id) {
  return id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

// ---------------------------------------------------------------- the six barrels

/**
 * The six barrel lines, as data. `half` is the file under the plugin's tree whose PRESENCE means
 * the plugin ships that half — an install writes a line only for the halves that arrived, so a
 * plugin with no CLI command does not get a CLI import of a file that is not there.
 *
 * Two of the six are `export *` rather than a tuple entry, and both carry `empty`: a TypeScript
 * file with no top-level import or export is a SCRIPT, not a module, so removing the last plugin
 * from one would make its single importer TS2306 and stop the whole app typechecking.
 */
export const BARRELS = Object.freeze({
  shared: {
    file: 'packages/shared/src/plugins/index.ts',
    constName: 'SHARED_PLUGINS',
    suffix: 'Shared',
    // `@rocketflare/shared`'s `./*` export maps to a FILE, so the `/index` is load-bearing.
    specifier: id => `./${id}/index`,
    half: id => `packages/shared/src/plugins/${id}/index.ts`,
  },
  server: {
    file: 'apps/web/src/plugins/server.ts',
    constName: 'SERVER_PLUGINS',
    suffix: 'Server',
    specifier: id => `./${id}`,
    half: id => `apps/web/src/plugins/${id}/index.ts`,
  },
  ui: {
    file: 'apps/web/src/plugins/ui.ts',
    constName: 'UI_PLUGINS',
    suffix: 'Ui',
    specifier: id => `./${id}/ui`,
    half: id => `apps/web/src/plugins/${id}/ui/index.ts`,
  },
  schema: {
    file: 'apps/web/src/plugins/schema.ts',
    constName: null, // `export *`, not a tuple
    suffix: null,
    // With no plugin installed this file is a comment and nothing else, and a TypeScript file with
    // no top-level import or export is a SCRIPT, not a module — so `db/schema/index.ts`'s
    // `export * from '../plugins/schema'` is TS2306 "is not a module" and the whole app stops
    // typechecking. The four LIST barrels always declare a const; the two `export *` ones
    // (this and `worker`) are the ones that need the marker.
    empty: 'export {}',
    specifier: id => `./${id}/db/schema`,
    half: id => `apps/web/src/plugins/${id}/db/schema/index.ts`,
  },
  /**
   * Durable Object and Workflow CLASSES (D31). Cloudflare resolves a binding's `class_name`
   * against the named exports of the Worker's ENTRY module, so a plugin shipping one needs a line
   * in `src/worker.ts` — and this barrel is that line, written once and for ever, so no install
   * ever edits the entry itself. Before it, the class was a printed instruction in the plan, which
   * an unattended install simply did not perform.
   */
  worker: {
    file: 'apps/web/src/plugins/worker-exports.ts',
    constName: null, // `export *`, not a tuple
    suffix: null,
    empty: 'export {}',
    specifier: id => `./${id}/worker-exports`,
    half: id => `apps/web/src/plugins/${id}/worker-exports.ts`,
  },
  cli: {
    file: 'apps/cli/src/plugins/index.ts',
    constName: 'CLI_PLUGINS',
    suffix: 'Cli',
    specifier: id => `./${id}`,
    half: id => `apps/cli/src/plugins/${id}/index.ts`,
  },
})

export const BARREL_KINDS = Object.freeze(Object.keys(BARRELS))

/** `exampleFeatureServer`, and so on. `null` for an `export *` barrel, which exports no name. */
export function barrelExportName(kind, id) {
  const { suffix } = BARRELS[kind]
  return suffix ? `${camelId(id)}${suffix}` : null
}

/** The one or two lines a barrel gains for `id`, as text — what the plan prints. */
export function barrelLines(kind, id) {
  const b = BARRELS[kind]
  const spec = b.specifier(id)
  if (!b.constName) return [`export * from '${spec}'`]
  const name = barrelExportName(kind, id)
  return [`import { ${name} } from '${spec}'`, `${b.constName} entry: ${name}`]
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when this barrel's text already names `id`. Both halves must be there. */
export function hasBarrelLine(text, kind, id) {
  const b = BARRELS[kind]
  const spec = escapeRe(b.specifier(id))
  if (!b.constName) return new RegExp(`^export \\* from '${spec}'$`, 'm').test(text)
  const name = barrelExportName(kind, id)
  const imported = new RegExp(`^import \\{ ${name} \\} from '${spec}'$`, 'm').test(text)
  return imported && tupleEntries(text, b.constName).includes(name)
}

/**
 * The identifiers inside `export const X = [ … ] as const`. `[]` when the const is not there.
 *
 * Anchored to the start of a LINE, and that is not fussiness: every barrel's header comment shows
 * the very line this matches (`export const SERVER_PLUGINS = [approvalsServer]`) as the example of
 * what an install writes, so an unanchored regex reads the documentation instead of the code.
 */
/** Biome's `lineWidth` (biome.json). A tuple wider than this is written one entry per line. */
const BARREL_LINE_WIDTH = 100

export function tupleEntries(text, constName) {
  const m = text.match(new RegExp(`^export const ${constName} = \\[([^\\]]*)\\]`, 'm'))
  if (!m) return []
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Rewrite `export const X = [ … ]`, in the formatting Biome would choose.
 *
 * The line width matters, and it is not cosmetics: `removeBarrelLine` is documented as the exact
 * inverse of `addBarrelLine`, and `plugin-lib.test.ts` proves it against the REAL barrels — so if
 * the writer emits one line where the formatter would emit five, every round trip over a formatted
 * barrel reports a diff that is not there. One plugin fits on a line; two stopped fitting the day
 * analytics was extracted (D31, Phase C), which is how this was found.
 */
function replaceTuple(text, constName, entries) {
  return text.replace(
    new RegExp(`^(export const ${constName} = \\[)[^\\]]*(\\][^\\n]*)$`, 'm'),
    (_match, open, close) => {
      const oneLine = `${open}${entries.join(', ')}${close}`
      if (oneLine.length <= BARREL_LINE_WIDTH || entries.length === 0) return oneLine
      return `${open}\n${entries.map(e => `  ${e},`).join('\n')}\n${close}`
    }
  )
}

/**
 * The plugin import lines of a barrel, as `{ index, line, specifier }`.
 *
 * "A plugin import" is a VALUE import from a relative specifier that is not `./types` — which is
 * exactly what a barrel contains, because a barrel imports nothing else. `import type` lines are
 * left where they are: Biome sorts them after the value imports and moving one would produce a
 * formatting diff on every install.
 */
function pluginImports(text) {
  const lines = text.split('\n')
  const found = []
  for (const [index, line] of lines.entries()) {
    const m = line.match(/^(?:import \{ (\w+) \}|export \*) from '(\.\/[^']+)'$/)
    if (m && m[2] !== './types') found.push({ index, line, name: m[1] ?? null, specifier: m[2] })
  }
  return found
}

/** Every one-line relative import or `export *` in a barrel — the lines Biome sorts together. */
function sortedImports(text) {
  const found = []
  for (const [index, line] of text.split('\n').entries()) {
    const m = line.match(/^(?:import (?:type )?\{ [^}]+ \}|export \*) from '(\.\/[^']+)'$/)
    if (m) found.push({ index, specifier: m[1] })
  }
  return found
}

/**
 * Write `id`'s line(s) into a barrel's text. Idempotent, and sorted by module specifier so the
 * result is byte-identical to what Biome's import sorting would produce — an install that leaves
 * `pnpm lint` unhappy is an install that cannot be committed.
 */
export function addBarrelLine(text, kind, id) {
  if (hasBarrelLine(text, kind, id)) return text
  const b = BARRELS[kind]
  // The first plugin displaces the "this is a module" marker the last one left behind.
  if (b.empty) text = dropLine(text, b.empty)
  const spec = b.specifier(id)
  const name = barrelExportName(kind, id)
  const newLine = b.constName ? `import { ${name} } from '${spec}'` : `export * from '${spec}'`

  // Biome sorts by specifier across EVERY import, the `import type … from './types'` included — so
  // a plugin whose id sorts after `types` (`web-knowledge`) lands BELOW it, not above. Sorting
  // against the plugin lines alone put it above and failed the round trip the moment one existed.
  const existing = sortedImports(text)
  const lines = text.split('\n')
  if (existing.length === 0) {
    // The schema barrel has no imports at all, so its one line goes after the last non-empty line
    // of the header comment.
    const lastText = lines.reduce((acc, l, i) => (l.trim() === '' ? acc : i), 0)
    lines.splice(lastText + 1, 0, newLine)
  } else {
    const before = existing.find(e => e.specifier > spec)
    lines.splice(before ? before.index : existing[existing.length - 1].index + 1, 0, newLine)
  }
  let next = lines.join('\n')
  if (b.constName) {
    const entries = [...tupleEntries(next, b.constName), name].sort()
    next = replaceTuple(next, b.constName, entries)
  }
  return next
}

/** The exact inverse of `addBarrelLine`: a round trip returns the original bytes. */
export function removeBarrelLine(text, kind, id) {
  const b = BARRELS[kind]
  const spec = b.specifier(id)
  const name = barrelExportName(kind, id)
  const drop = b.constName ? `import { ${name} } from '${spec}'` : `export * from '${spec}'`
  let next = dropLine(text, drop)
  if (b.constName) {
    const entries = tupleEntries(next, b.constName).filter(e => e !== name)
    next = replaceTuple(next, b.constName, entries)
  }
  // Removing the LAST plugin from the schema barrel would leave a file with no exports at all,
  // which TypeScript reads as a script rather than a module (TS2306 at its one importer). A bare
  // kit has to typecheck, so the marker goes back exactly where the line was.
  if (b.empty && pluginImports(next).length === 0 && !next.includes(b.empty)) {
    next = appendAfterHeader(next, b.empty)
  }
  return next
}

/**
 * A plugin's edits to a CORE file, applied and reversed (D31, decision 12's sibling).
 *
 * A plugin owns four directories and edits no core file — that rule is what lets two plugins share
 * one app. But some need a line in one: the analytics plugin cannot render at all unless
 * `apps/web/vite.config.ts` aliases `@nivo/heatmap` to the stub it ships, because drizzle-cube's
 * heat-map chunk names that OPTIONAL peer and Rollup fails the whole build without it.
 *
 * Printing the line as a "by hand" step left `pnpm build` failing for anyone who did not read the
 * plan — including `plugin-ci.yml`, which runs the gate unattended and applies nothing. So a
 * plugin DECLARES the edit and the host writes it, exactly as `bindings[]` declares a resource
 * that `provision cloudflare` writes: the plugin still edits nothing, and the host still owns
 * every byte of its own files.
 *
 * An edit is `{ file, after, lines }` — insert `lines` on the line following the first occurrence
 * of `after`, at that anchor's indentation. Anchored rather than positional because a core file
 * moves underneath a plugin between kit releases, and a line number would silently land in the
 * wrong block.
 *
 * Idempotent (a line already present is left alone), and `revertCoreEdits` is its exact inverse,
 * so add → remove returns the original bytes. A missing anchor THROWS with the file and the text
 * it looked for: silently skipping it produces a build failure somewhere else entirely, which is
 * the failure mode this whole function exists to remove.
 */
export function applyCoreEdits(text, edits) {
  let next = text
  for (const edit of edits) {
    const anchorIndex = next.split('\n').findIndex(l => l.includes(edit.after))
    if (anchorIndex === -1) {
      throw new Error(
        `core edit for ${edit.file}: no line contains ${JSON.stringify(edit.after)} — ` +
          'the anchor moved, so the kit and the plugin disagree about this file'
      )
    }
    const lines = next.split('\n')
    const indent = lines[anchorIndex].match(/^\s*/)[0]
    const missing = edit.lines.filter(l => !lines.some(existing => existing.trim() === l.trim()))
    if (missing.length === 0) continue
    lines.splice(anchorIndex + 1, 0, ...missing.map(l => `${indent}${l}`))
    next = lines.join('\n')
  }
  return next
}

/** The exact inverse of `applyCoreEdits`: a round trip returns the original bytes. */
export function revertCoreEdits(text, edits) {
  let next = text
  for (const edit of edits) {
    for (const line of edit.lines) {
      next = next
        .split('\n')
        .filter(existing => existing.trim() !== line.trim())
        .join('\n')
    }
  }
  return next
}

/** Every core edit a manifest declares, grouped by the file it touches. */
export function coreEditsByFile(manifest) {
  const byFile = new Map()
  for (const edit of manifest.coreEdits ?? []) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, [])
    byFile.get(edit.file).push(edit)
  }
  return byFile
}

const dropLine = (text, line) =>
  text
    .split('\n')
    .filter(l => l !== line)
    .join('\n')

/** Put `line` after the last non-empty line of a barrel with nothing else in it. */
function appendAfterHeader(text, line) {
  const lines = text.split('\n')
  const lastText = lines.reduce((acc, l, i) => (l.trim() === '' ? acc : i), 0)
  lines.splice(lastText + 1, 0, line)
  return lines.join('\n')
}

// ---------------------------------------------------------------- the plugin tree

/** What a file in a plugin's repository is, and what `add` does with it. */
export const FILE_ROLES = Object.freeze([
  'copy', // one of the three trees or docs/plugins/<id> — copied at the identical path
  'note', // docs/upgrades/*.md — copied to docs/plugins/<id>/upgrades/
  'fragment', // migrations/** — NEVER copied; pasted into a `--custom` migration by a human
  'meta', // the manifest, README/CHANGELOG/LICENSE — read, reported, not copied
  'repo-only', // the plugin repository's own tooling — belongs to it, not to the host
  'refused', // anywhere else: a plugin may not write outside its own roots
])

/** The four host directories a plugin owns, in the order the plan prints them. */
export function pluginRoots(id) {
  return [
    `apps/web/src/plugins/${id}/`,
    `packages/shared/src/plugins/${id}/`,
    `apps/cli/src/plugins/${id}/`,
    `docs/plugins/${id}/`,
  ]
}

/**
 * Built from `KIT.slug` for the reason `MANIFEST_FILE` is (see `manifest.mjs`): this is the
 * ECOSYSTEM's filename, the same in every plugin repository, so a renamed copy that looked for
 * `<slug>-plugin.json` could never install any plugin at all.
 */
export const PLUGIN_MANIFEST_FILE = `${KIT.slug}-plugin.json`

const META_FILES = ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'SECURITY.md']
/**
 * Files that belong to the plugin's own REPOSITORY and have no place in a host tree. They are not
 * a refusal — a plugin repo needs a CI workflow (that is half of decision 5) and a `.gitignore` —
 * but nothing under here is ever copied, including a `package.json`: dependencies are declared in
 * the manifest and installed into the HOST's packages.
 */
const REPO_ONLY = [
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  'package.json',
  'pnpm-lock.yaml',
  'biome.json',
]
/**
 * `scripts/` is on this list because a plugin repository carries its own release entry point: there
 * is no `pnpm plugin:release`, so a plugin repo keeps a thin `scripts/` of its own that DELEGATES to
 * a kit checkout — `release.mjs` takes `--repo-root <path>`, so the machinery lives in one place and
 * the plugin repo holds the shim rather than a copy that drifts. They are the plugin repo's OWN
 * tooling in exactly the sense `.github/` is — and without this entry the first real plugin was refused at install for
 * carrying the very files the kit told it to carry, which is how this was found (D31, Phase C).
 * Nothing under here is ever copied into a host, where `scripts/` is the kit's.
 */
const REPO_ONLY_DIRS = ['.github/', '.git/', 'node_modules/', '.claude/', 'scripts/']

/**
 * What `add` does with one repo-relative path of a plugin's tree.
 *
 * The rule this exists to enforce: **a plugin writes only inside its own four roots.** Anything
 * else is a refusal rather than a warning, because the alternative is a plugin that edits
 * `api/index.ts` on the way in and an install nobody can reverse by deleting a directory.
 */
export function classifyPluginFile(relPath, id) {
  if (relPath === PLUGIN_MANIFEST_FILE) return { role: 'meta', reason: "the plugin's manifest" }
  if (META_FILES.includes(relPath)) return { role: 'meta', reason: 'repository documentation' }
  if (REPO_ONLY.includes(relPath) || REPO_ONLY_DIRS.some(d => relPath.startsWith(d))) {
    return { role: 'repo-only', reason: "belongs to the plugin's repository, not to a host" }
  }
  if (relPath.startsWith('migrations/')) {
    return {
      role: 'fragment',
      reason: 'a data fragment — the HOST generates every migration (`pnpm db:generate`)',
    }
  }
  if (relPath.startsWith('docs/upgrades/')) {
    return { role: 'note', target: `docs/plugins/${id}/upgrades/${relPath.split('/').pop()}` }
  }
  const root = pluginRoots(id).find(r => relPath.startsWith(r))
  if (root) return { role: 'copy', target: relPath, root }
  return {
    role: 'refused',
    reason: `outside the plugin's own roots (${pluginRoots(id).join(', ')})`,
  }
}

// ---------------------------------------------------------------- platform declarations

/**
 * The binding types provisioning knows how to write (D31, decision 12).
 *
 * **This list exists twice and the duplication is pinned, not silent.**
 * `apps/web/scripts/provision/plugin-resources.ts` owns the TypeScript half and is what
 * `pnpm provision cloudflare <env>` reads; this is the `.mjs` half, because `scripts/plugin.mjs`
 * runs under plain Node and cannot import a `.ts` module. `plugin-lib.test.ts` asserts the two are
 * identical, so narrowing or widening one without the other fails the suite. Checking it HERE is
 * what makes an unsupported type stop an INSTALL, rather than surface as a 503 on the first
 * request after a deploy that silently skipped the binding.
 */
export const SUPPORTED_PLUGIN_BINDING_TYPES = Object.freeze([
  'kv',
  'queue',
  'r2',
  'workflow',
  'durable_object',
])

/**
 * The subset an account has to CREATE before a deploy. `workflow` and `durable_object` are not
 * here because `wrangler deploy` registers both from the toml — there is nothing to find-or-create
 * — so `PLUGIN_RESOURCES` never carries one and `cf-provision.sh` never sees one.
 */
export const CREATED_PLUGIN_BINDING_TYPES = Object.freeze(['kv', 'queue', 'r2'])

/** Types whose block names a CLASS exported from the Worker's entry module (the sixth barrel). */
export const CLASS_PLUGIN_BINDING_TYPES = Object.freeze(['workflow', 'durable_object'])

/** Types carrying an account-scoped resource NAME, which must differ between the environments. */
export const NAMED_PLUGIN_BINDING_TYPES = Object.freeze(['kv', 'queue', 'r2', 'workflow'])

/** How a Durable Object's storage is created. Irreversible, so it is declared rather than guessed. */
export const DO_STORAGE_KINDS = Object.freeze(['sqlite', 'none'])

/**
 * Everything wrong with a plugin's platform declarations, as sentences. Empty means installable.
 *
 * Only what `add` can usefully refuse. The full shape validation — binding-name casing, resource
 * names, duplicate keys across plugins — belongs to `plugin-resources.ts`, which runs at provision
 * time with the whole installed set in view.
 */
export function pluginPlatformProblems(manifest) {
  const problems = []
  for (const b of manifest.bindings ?? []) {
    const who = b.binding ?? b.name ?? '?'
    if (!SUPPORTED_PLUGIN_BINDING_TYPES.includes(b.type)) {
      problems.push(
        `binding ${who} declares type '${b.type}', which provisioning cannot ` +
          `write (supported: ${SUPPORTED_PLUGIN_BINDING_TYPES.join(', ')})`
      )
      continue
    }
    // A class binding is only writable because the sixth barrel makes the class reachable from
    // `src/worker.ts`; the manifest has to say WHICH class, or the block points at nothing and
    // `wrangler deploy` refuses the whole script.
    if (CLASS_PLUGIN_BINDING_TYPES.includes(b.type) && !b.className) {
      problems.push(`binding ${who} is a ${b.type} and declares no className`)
    }
    if (!CLASS_PLUGIN_BINDING_TYPES.includes(b.type) && b.className) {
      problems.push(
        `binding ${who} declares className, which is only meaningful on a class binding`
      )
    }
    // A Durable Object's storage kind cannot be changed after the namespace exists, so it is
    // declared rather than defaulted: guessing it wrong is not a thing anyone can undo.
    if (b.type === 'durable_object' && !DO_STORAGE_KINDS.includes(b.storage)) {
      problems.push(
        `binding ${who} must declare storage as one of ${DO_STORAGE_KINDS.join(' | ')} — ` +
          'it picks new_sqlite_classes vs new_classes and cannot be changed later'
      )
    }
    if (b.type !== 'durable_object' && b.storage) {
      problems.push(`binding ${who} declares storage, which only a durable_object has`)
    }
    if (NAMED_PLUGIN_BINDING_TYPES.includes(b.type) && !b.name) {
      problems.push(`binding ${who} declares no name (the account-scoped half of the resource)`)
    }
  }
  return problems
}

/**
 * The `[[migrations]]` tag an install writes for a plugin's Durable Object classes.
 *
 * **DO migrations are to `worker.ts` what SQL migrations are to `db/schema`**: an append-only
 * record of what this Worker has already told Cloudflare, numbered in the HOST's file. A tag is
 * never renumbered and never rewritten — replaying one under a different meaning loses a namespace
 * and everything stored in it. Install is always `v1`; a later change (a removal's
 * `deleted_classes`) takes the next free number.
 */
export function pluginMigrationTag(pluginId, n = 1) {
  return `plugin-${pluginId}-v${n}`
}

/** The next free `plugin-<id>-v<n>`, given every tag already in the toml. */
export function nextPluginMigrationTag(existingTags, pluginId) {
  const re = new RegExp(`^plugin-${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)$`)
  const used = existingTags.map(t => Number(re.exec(t)?.[1])).filter(n => Number.isInteger(n))
  return pluginMigrationTag(pluginId, used.length === 0 ? 1 : Math.max(...used) + 1)
}

// ---------------------------------------------------------------- requirements

/**
 * Every unmet entry of `requires`, as a sentence. An empty array means the plugin may be installed.
 *
 * All three are checked and ALL failures are returned, never the first: somebody about to pin a
 * different version wants the whole list, and finding the second requirement only after fixing the
 * first is two round trips for no reason.
 *
 * `vendored` skips the kit range. A plugin whose `source.repo` is the kit's own repository with no
 * subdirectory ships INSIDE the kit — the same release cut both, so the range describes the kit it
 * came from rather than a compatibility claim, and checking it makes the kit fail against itself
 * for the whole of the release in which the plugin's range is raised.
 */
export function checkRequirements({
  requires = {},
  minKit = null,
  uses = null,
  ledger = null,
  kitVersion,
  presentSurfaces = [],
  installedPlugins = [],
  vendored = false,
}) {
  const problems = []
  // (a) The FLOOR. One version, no ceiling: a plugin can say how old a kit it still works with,
  // and cannot predict which future kit will break it — that is what the ledger diff below
  // measures instead of guessing.
  if (minKit && !vendored) {
    if (!BARE_VERSION.test(minKit)) {
      problems.push(
        `minKit '${minKit}' is not a bare X.Y.Z version — minKit is a floor, not a range`
      )
    } else if (compareVersions(kitVersion, minKit) < 0) {
      problems.push(
        `kit ${kitVersion} is older than this plugin's minKit ${minKit} — upgrade the kit, or install an earlier release of the plugin`
      )
    }
  }
  for (const id of requires.surfaces ?? []) {
    if (!presentSurfaces.includes(id)) problems.push(`surface '${id}' is not present in this app`)
  }
  for (const req of requires.plugins ?? []) {
    const { id, minVersion } = parsePluginRequirement(req)
    const found = installedPlugins.find(p => p.id === id)
    if (!found) {
      problems.push(`plugin '${id}' is required and not installed`)
      continue
    }
    if (!minVersion) continue
    if (!BARE_VERSION.test(minVersion)) {
      problems.push(
        `plugin '${id}' is required at minVersion '${minVersion}', which is not a bare X.Y.Z version`
      )
      continue
    }
    if (compareVersions(found.version ?? '0.0.0', minVersion) < 0) {
      problems.push(
        `plugin '${id}' is ${found.version ?? 'unversioned'}, older than the minVersion ${minVersion} this plugin needs`
      )
    }
  }
  // (d) **The ledger diff — the whole of the compatibility question.** `uses` is what this plugin
  // names of the host surface (derived from its own imports, never typed by an author); `ledger`
  // is what this kit provides. The answer is a set difference over strings: deterministic, with no
  // grammar to get wrong, and with no path out of it that can throw. Whatever is missing names
  // itself and carries the replacement import when the symbol has merely moved entry.
  for (const m of missingFrom(uses, ledger)) {
    problems.push(
      `${m.entry} :: ${m.symbol} is not in this kit's surface — ` +
        (m.suggestion ?? 'no replacement: it is gone (see docs/plugin-api.md)')
    )
  }
  return problems
}

/**
 * The installed plugins a move to kit `version` would leave unsupported.
 *
 * Shared by `plugin add|check` and by `kit:upgrade` because it has to answer the same, and once did
 * not: `plugin check` printed "vendored — the floor is not checked" and exited 0 while
 * `kit:upgrade`, in the same checkout, refused with exit 6 over the same plugin. A VENDORED plugin
 * ships inside the kit, so its floor describes the kit it came out of rather than a compatibility
 * claim about a kit it has never seen — the release that moves the kit moves it too.
 */
export function unsupportedForKit(plugins, { kitRepo, version }) {
  if (!version) return []
  return plugins.filter(p => {
    const floor = floorOf(p)
    if (!floor || isVendored(p.source, kitRepo)) return false
    // A floor this kit cannot READ counts as unsupported: "I cannot check this plugin against the
    // target" is not a reason to wave it through.
    if (!BARE_VERSION.test(floor)) return true
    return compareVersions(version, floor) < 0
  })
}

/**
 * A plugin's declared floor, from a manifest or from a surface.
 *
 * **Top level ONLY, and the strictness is the point.** `minKit` is a sibling of `id` and
 * `version`; a fallback to `requires.minKit` would mean this reader and
 * `.github/workflows/plugin-ci.yml` — which reads the top-level key and nothing else — disagreed
 * about one spelling, so a misplaced floor would pass `pnpm plugin check` here and fail in CI
 * there. Quietly repairing the wrong shape is the silent drift this whole change removes;
 * `pluginManifestProblems` fails it loudly instead, naming where the field belongs.
 */
export function floorOf(m) {
  return m?.minKit ?? null
}

/**
 * `{ id, minVersion }` — a FLOOR, never a range.
 *
 * A bare `"approvals"` asks only for presence. The old `"approvals@>=1.0.0 <2.0.0"` spelling is
 * gone: `pluginManifestProblems` refuses it by name, so it can never reach here silently.
 */
export function parsePluginRequirement(entry) {
  if (typeof entry === 'object' && entry !== null)
    return { id: entry.id, minVersion: entry.minVersion ?? null }
  return { id: String(entry), minVersion: null }
}

/**
 * True when this plugin ships inside the kit itself (`example-feature` is the one that does).
 *
 * **Re-exported, not reimplemented.** There were two of these and they disagreed about a URL with a
 * trailing slash or without `.git`, so one plugin could read as vendored for `kit:release` and as
 * third-party for `plugin check` in the same checkout. `upgrade-lib.mjs` owns it — this file
 * already imports that one, and the reverse direction would be a cycle.
 */
export { isVendored }

// ---------------------------------------------------------------- the surface

/**
 * The `.rocketflare.json` entry an install writes. Deliberately built from the plugin's own
 * manifest plus the three facts only the host knows — where it fetched it from, at what commit and
 * when — so a surface never carries a field the plugin did not declare.
 */
export function buildPluginSurface(manifest, { repo, subdir = '', commit = null, at }) {
  const id = manifest.id
  return {
    id,
    kind: 'plugin',
    label: manifest.label ?? id,
    anchor: manifest.anchor ?? `apps/web/src/plugins/${id}/plugin.json`,
    // `docs/plugins/<id>/**` is always included, declared or not: `add` copies the plugin's release
    // notes there, and if the surface did not name them `kit-manifest.test.ts` would report them as
    // unclassified files and `remove` would leave them behind. A plugin's own `paths` name its CODE
    // trees, which is what an author thinks about — the notes are the host's doing, so the host
    // adds them (D31, found in Phase C the first time a plugin shipped notes).
    paths: [
      ...new Set([
        ...(manifest.paths ?? pluginRoots(id).map(r => `${r}**`)),
        `docs/plugins/${id}/**`,
      ]),
    ],
    registries: manifest.registries ?? Object.values(BARRELS).map(b => b.file),
    source: { repo, subdir, version: manifest.version ?? null, commit },
    installedAt: at,
    // `null`, not a wildcard. A plugin that declares no floor has said nothing, and recording
    // "anything" puts it beyond every gate there is: `checkRequirements` skips it,
    // `unsupportedForKit` skips it, and `kit:upgrade` would carry it across a major version
    // without a word. Null is the same silence, but it is VISIBLE — `plugin check` and the
    // install plan both say so.
    minKit: floorOf(manifest),
    requires: {
      surfaces: manifest.requires?.surfaces ?? [],
      plugins: manifest.requires?.plugins ?? [],
    },
    history: [],
  }
}

/** The directory prefix of each `paths` glob — what `remove` deletes. */
export function surfaceDirectories(surface) {
  return (surface.paths ?? [])
    .map(g => g.replace(/\/?\*\*.*$/, ''))
    .filter(p => p !== '' && !p.includes('*'))
}

/**
 * `CREATE TABLE archive.<t> AS TABLE public.<t>` per table — `pnpm plugin remove --archive`.
 *
 * A copy into another SCHEMA rather than a rename in place, so the next `pnpm db:generate` sees
 * exactly what it should: the plugin's tables gone from `public`, and nothing it has ever heard of
 * in `archive`. `rls-coverage.test.ts` scopes every one of its catalog queries to `public`, so the
 * copies are invisible to it — and invisible to `typeof schema`, which is the point.
 */
export function archiveSql(id, tables) {
  return [
    `-- Archive of the '${id}' plugin's tables, taken by \`pnpm plugin remove ${id} --archive\`.`,
    '-- Data only: no indexes, no constraints, no RLS policy. Drop the schema when you are sure.',
    'CREATE SCHEMA IF NOT EXISTS archive;',
    ...tables.map(t => `CREATE TABLE IF NOT EXISTS archive."${t}" AS TABLE public."${t}";`),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- the plan

const pad = (s, n) => String(s).padEnd(n)

/**
 * The install plan, as lines. Pure over a plain object so a test can pin the whole text for a
 * fixture manifest — this is the thing a human reads before saying yes, and the one output where
 * an omission ("it also needs a binding") is a broken deploy rather than a wrong sentence.
 */
export function renderAddPlan(plan) {
  const m = plan.manifest
  const lines = [
    `Plugin      ${m.id}@${m.version ?? '?'} — ${m.label ?? m.id}`,
    `Source      ${plan.source.repo}${plan.source.subdir ? `#${plan.source.subdir}` : ''}` +
      `${plan.source.ref ? ` @ ${plan.source.ref}` : ''}${plan.source.commit ? ` (${plan.source.commit.slice(0, 12)})` : ''}`,
    `Host        ${plan.host.label} at kit ${plan.host.kitVersion} — records into ${plan.host.recordsIn}`,
    `Names       ${plan.host.translated ? `translated into ${plan.host.label}'s vocabulary on the way in` : 'kit vocabulary, copied verbatim'}`,
    '',
    'Requirements',
  ]
  if (plan.problems.length === 0) {
    const floor = floorOf(m)
    const symbols = Object.values(m.uses ?? {}).reduce((n, names) => n + names.length, 0)
    lines.push(
      // An undeclared floor is stated rather than ticked: it means no kit version is ever checked
      // against this plugin, which is worth reading before saying yes.
      floor === null
        ? `  ⚠ kit ${plan.host.kitVersion} — this plugin declares no minKit, so no kit version is ever checked against it`
        : `  ✔ kit ${plan.host.kitVersion} is at or above minKit ${floor}` +
            (plan.vendored
              ? ' (vendored — shipped with the kit, so the floor is not checked)'
              : ''),
      // The measured half: every symbol this plugin names is one this kit still provides. It is
      // the answer a version number used to guess at.
      `  ✔ surface: all ${symbols} symbol(s) it uses are in this kit's ledger`,
      `  ✔ surfaces: ${(m.requires?.surfaces ?? []).join(', ') || 'none required'}`,
      `  ✔ plugins:  ${(m.requires?.plugins ?? []).map(p => p?.id ?? p).join(', ') || 'none required'}`
    )
  } else {
    for (const p of plan.problems) lines.push(`  ✖ ${p}`)
  }

  lines.push('', `Files (${plan.files.filter(f => f.role === 'copy' || f.role === 'note').length})`)
  for (const [root, count] of Object.entries(plan.byRoot)) lines.push(`  ${pad(root, 44)}${count}`)
  const notes = plan.files.filter(f => f.role === 'note').length
  if (notes > 0)
    lines.push(`  ${pad(`docs/upgrades/ → docs/plugins/${m.id}/upgrades/`, 44)}${notes}`)
  const fragments = plan.files.filter(f => f.role === 'fragment')
  if (fragments.length > 0) {
    lines.push(`  ${pad('(not copied) migrations/', 44)}${fragments.length} install fragment(s)`)
  }

  lines.push('', 'Barrel lines')
  for (const kind of plan.barrels) {
    lines.push(`  ${pad(BARRELS[kind].file, 44)}${barrelLines(kind, m.id).join('  +  ')}`)
  }
  if (plan.barrels.length === 0) lines.push('  (none — this plugin ships no half the host wires)')

  const deps = Object.entries(m.dependencies ?? {}).filter(
    ([, d]) => Object.keys(d ?? {}).length > 0
  )
  lines.push('', 'Dependencies')
  if (deps.length === 0) lines.push('  none declared')
  for (const [pkg, d] of deps) {
    lines.push(
      `  ${pad(pkg, 44)}${Object.entries(d)
        .map(([n, v]) => `${n}@${v}`)
        .join(' ')}`
    )
  }

  const declaredEdits = m.coreEdits ?? []
  if (declaredEdits.length > 0) {
    lines.push('', 'Core files (applied for you — a plugin may not edit these itself)')
    for (const [file, edits] of coreEditsByFile(m)) {
      lines.push(`  ${pad(file, 44)}${edits.flatMap(e => e.lines).length} line(s)`)
    }
  }

  const clashes = plan.clashes ?? []
  if (clashes.length > 0) {
    lines.push('', 'Dependency clashes (nothing is overwritten until you say so)')
    for (const c of clashes) lines.push(`  ⚠ ${describeClash(c)}`)
  }

  lines.push(...renderSteps(planSteps(m, { fragments: fragments.map(f => f.path), clashes })))

  if (plan.verify) lines.push('', "Verify (from the plugin's own note)", ...indent(plan.verify))
  return lines
}

// ---------------------------------------------------------------- the step taxonomy

/**
 * What a step COSTS somebody, and why "by hand" is retired as a phrase.
 *
 * It answers neither of the two questions that matter to whatever performs the step, and installs
 * are performed by AGENTS as often as by people now. Prose an agent may skim is not a control —
 * that is precisely how `workerExports` and `coreEdits` each produced a tree that built and then
 * failed somewhere else entirely. So every remaining step declares which of three it is:
 *
 *   - `declarative` — nobody does it; the tooling does. These do not appear at all. Everything
 *     Parts 1 and 2 moved (the barrel lines, bindings, crons, prefixes, vars, the DO migration
 *     tag) left this list by BECOMING declarative, which is the only honest way to shorten it.
 *   - `agent`       — an instruction PLUS a check that proves it was done. Without the check it is
 *     a sentence, and a sentence is the thing being replaced.
 *   - `human`       — a DECISION: a secret's value, a migration that drops something, retiring a
 *     Durable Object namespace, deleting a live resource. Not automatable in PRINCIPLE rather than
 *     merely unimplemented — that distinction is what stops this list collecting excuses.
 *
 * Every step carries the exact `command`, the observable `expect` and the `assert` that proves it,
 * so `--json` can make a human step structurally unmissable rather than a sentence in a paragraph.
 */
export const STEP_KINDS = Object.freeze(['declarative', 'agent', 'human'])

const mkStep = (kind, id, title, command, expected, assertion) => ({
  kind,
  id,
  title,
  command,
  expect: expected,
  assert: assertion,
})

const GATE = 'pnpm lint && pnpm typecheck && pnpm test && pnpm build'

/** The platform declarations one `pnpm provision cloudflare <env>` run will write, as phrases. */
function platformSummary(m) {
  return [
    ...(m.bindings ?? []).map(b => `${b.type} binding ${b.binding ?? b.name}`),
    ...(m.crons ?? []).map(c => `cron "${c.cron ?? c}"`),
    ...(m.apiPrefixes ?? []).map(p => `route prefix ${p}`),
    ...(m.vars ?? []).filter(v => !v.secret).map(v => `[vars] ${v.key ?? v.name ?? v}`),
  ]
}

const varKey = v => v.key ?? v.name ?? v

/**
 * Every step an INSTALL still needs once the tooling has done its half, classified.
 *
 * `fragments` is the repo-relative path of each `migrations/` file the plugin ships, which is
 * never copied — the host pastes it into a `--custom` migration of its own.
 */
export function planSteps(m, { fragments = [], clashes = [] } = {}) {
  const steps = []
  const version = m.version ?? '0.0.0'
  if (clashes.length > 0) {
    // HUMAN, and first: `pnpm add` would overwrite the existing range without a word, and the
    // host's `package.json` is `manual` in `.rocketflare.json`, so nothing reconciles it later.
    // Choosing a range two dependants can both live with is a judgement, not a command.
    steps.push(
      mkStep(
        'human',
        'dependency-clash',
        `Decide the range for ${[...new Set(clashes.map(c => c.name))].join(', ')}`,
        clashes.map(describeClash).join('; '),
        'one range in the host package.json that every dependant can live with',
        'a person chooses — `pnpm add` silently overwrites the existing range, and no kit upgrade' +
          ' ever reconciles a package.json'
      )
    )
  }
  const tables = m.schema?.tables ?? []
  if (tables.length > 0) {
    steps.push(
      mkStep(
        'agent',
        'schema-migration',
        `Generate and apply the migration for ${tables.join(', ')}`,
        `pnpm db:generate --name plugin-${m.id}-${version}   # read the SQL, then: pnpm db:migrate`,
        `one new migration whose SQL is CREATE TABLE ${tables.join(', ')} and nothing else`,
        'pnpm plugin check   # fails while a plugin declares tables and no migration names it'
      )
    )
  }
  if (fragments.length > 0) {
    steps.push(
      mkStep(
        'agent',
        'data-fragment',
        `Paste the plugin's ${fragments.length} install fragment(s) into a --custom migration`,
        `pnpm db:generate --custom --name plugin-${m.id}-install   # paste ${fragments.join(', ')}`,
        'an empty migration file, then the fragment SQL inside it',
        'pnpm db:migrate   # it applies, and the rows the fragment seeds are there'
      )
    )
  }
  const platform = platformSummary(m)
  if (platform.length > 0) {
    // ONE command per environment rather than a hand edit of two tomls (decision 12). An AGENT
    // step and not a declarative one because somebody still has to RUN it, against an account,
    // with credentials — what disappeared is every byte of the toml, not the invocation.
    steps.push(
      mkStep(
        'agent',
        'provision',
        "Create and declare this plugin's platform resources, per environment",
        'pnpm provision cloudflare staging && pnpm provision cloudflare production',
        `${platform.join(', ')} written into BOTH tomls; ids patched per environment`,
        'REQUIRE_PROVISIONED=1 pnpm --filter @rocketflare/web test:config'
      )
    )
  }
  for (const v of (m.vars ?? []).filter(v => v.secret)) {
    const key = varKey(v)
    // The KEY and the VALUE are two different kinds, and splitting them is the point: declaring
    // the key is mechanical and checkable, while the value is a credential only a person has.
    steps.push(
      mkStep(
        'agent',
        `secret-key:${key}`,
        `Declare the secret ${key} — the key only, never a [vars] entry`,
        `add \`${key}=\` to apps/web/.dev.vars.example`,
        `${key} listed in .dev.vars.example and in NEITHER wrangler toml`,
        `grep -q '^${key}=' apps/web/.dev.vars.example`
      ),
      mkStep(
        'human',
        `secret-value:${key}`,
        `Set a value for ${key}`,
        'pnpm provision secrets <env>   # read from your shell or apps/web/.provision.env',
        `${key} in \`wrangler secret list\` for that environment`,
        'a person supplies the credential; nothing can derive it'
      )
    )
  }
  steps.push(
    mkStep(
      'agent',
      'gate',
      'Run the gate',
      GATE,
      'all four commands exit 0',
      'the exit code of the last command is 0'
    )
  )
  return steps
}

/**
 * The steps a REMOVE still needs. Most are human, and each destroys something: a migration full of
 * `DROP TABLE`, the `--archive` copy taken (or knowingly not taken) before it, a `deleted_classes`
 * migration that takes a Durable Object namespace and everything stored in it, and live Cloudflare
 * resources that may still hold somebody's data.
 */
export function removeSteps(m, { archive = false, migrationTag = null } = {}) {
  const steps = []
  const tables = m.schema?.tables ?? []
  if (tables.length > 0 && archive) {
    steps.push(
      mkStep(
        'human',
        'archive',
        `Copy ${tables.join(', ')} into schema "archive" BEFORE they are dropped`,
        'pnpm db:migrate   # applies the --custom archive migration `plugin remove --archive` wrote',
        'each table copied into schema "archive"; `public` untouched until the drop',
        'a person decides whether this data is worth keeping — skipping it is not reversible'
      )
    )
  }
  if (tables.length > 0) {
    steps.push(
      mkStep(
        'human',
        'drop-migration',
        `Generate and apply the migration that DROPS ${tables.join(', ')}`,
        `pnpm db:generate --name plugin-${m.id}-remove   # read the SQL, then: pnpm db:migrate`,
        `DROP TABLE for ${tables.join(', ')} and nothing else`,
        'a person reads a migration containing DROP before it runs'
      )
    )
  }
  const doBindings = (m.bindings ?? []).filter(b => b.type === 'durable_object')
  if (doBindings.length > 0) {
    // Both halves are why this is a decision. A DO class that leaves the code with no
    // `deleted_classes` migration makes `wrangler deploy` REFUSE the whole script — and the
    // migration itself deletes the namespace and its storage.
    steps.push(
      mkStep(
        'human',
        'do-migration',
        `Retire the Durable Object class(es) ${doBindings.map(b => b.className).join(', ')}`,
        `add to BOTH tomls:  [[migrations]] tag = "${migrationTag ?? `plugin-${m.id}-v2`}"  ` +
          `deleted_classes = [${doBindings.map(b => `"${b.className}"`).join(', ')}]`,
        'the tag appended AFTER every existing one — never renumbered, never rewritten',
        'a person accepts that this deletes the namespace and everything stored in it'
      )
    )
  }
  const platform = platformSummary(m)
  // `platformSummary` already names every binding, a Durable Object's included.
  if (platform.length > 0) {
    steps.push(
      mkStep(
        'human',
        'deprovision',
        "Remove this plugin's blocks from both tomls and its resources from Cloudflare",
        `remove ${platform.join(', ')} from BOTH tomls, then delete the resources`,
        "both tomls free of the plugin's blocks; the parity test still green",
        'a live queue or bucket may hold data — nothing deletes one because a directory went'
      )
    )
  }
  const deps = Object.entries(m.dependencies ?? {}).filter(
    ([, d]) => Object.keys(d ?? {}).length > 0
  )
  for (const [pkg, d] of deps) {
    steps.push(
      mkStep(
        'agent',
        `dependencies:${pkg}`,
        `Drop ${pkg}'s dependencies on this plugin, if nothing else uses them`,
        `pnpm --dir ${pkg} remove ${Object.keys(d).join(' ')}`,
        'the packages gone from that package.json',
        GATE
      )
    )
  }
  steps.push(
    mkStep('agent', 'gate', 'Run the gate', GATE, 'all four commands exit 0', 'the exit code is 0')
  )
  return steps
}

const KIND_HEADING = {
  agent: 'Agent steps — run the command, then check the assertion',
  human: 'Human steps — a DECISION. Nothing here is automatable; the tooling stops',
}

/** The steps as plan lines, grouped by kind so a human step cannot read as one more command. */
export function renderSteps(steps, heading = 'Steps — nothing below is done for you') {
  const lines = ['', heading]
  for (const kind of ['human', 'agent']) {
    const group = steps.filter(s => s.kind === kind)
    if (group.length === 0) continue
    lines.push('', `  ${KIND_HEADING[kind]}`)
    group.forEach((s, i) => {
      lines.push(
        `    ${i + 1}. ${s.title}`,
        `       run     ${s.command}`,
        `       expect  ${s.expect}`,
        `       assert  ${s.assert}`
      )
    })
  }
  return lines
}

/**
 * The install plan as DATA — `pnpm plugin add --json`. The same facts as the text, in a shape
 * where a `human` step is a field rather than a paragraph somebody has to notice.
 */
export function addPlanJson(plan) {
  const m = plan.manifest
  const fragments = plan.files.filter(f => f.role === 'fragment').map(f => f.path)
  return {
    plugin: { id: m.id, version: m.version ?? null, label: m.label ?? m.id },
    source: plan.source,
    host: plan.host,
    vendored: plan.vendored,
    problems: plan.problems,
    installable: plan.problems.length === 0,
    files: {
      copied: plan.files.filter(f => f.role === 'copy' || f.role === 'note').length,
      byRoot: plan.byRoot,
      fragments,
      refused: plan.files.filter(f => f.role === 'refused').map(f => f.path),
    },
    barrels: plan.barrels.map(kind => ({
      kind,
      file: BARRELS[kind].file,
      lines: barrelLines(kind, m.id),
    })),
    dependencies: m.dependencies ?? {},
    dependencyClashes: (plan.clashes ?? []).map(c => ({ ...c, message: describeClash(c) })),
    coreEdits: [...coreEditsByFile(m)].map(([file, edits]) => ({
      file,
      lines: edits.flatMap(e => e.lines),
    })),
    steps: planSteps(m, { fragments, clashes: plan.clashes ?? [] }),
    verify: plan.verify ?? null,
  }
}

const indent = text =>
  text
    .trim()
    .split('\n')
    .map(l => `  ${l}`)

/** `pnpm plugin list` — one line per installed plugin. */
export function renderList(surfaces, { sidecarIds = [] } = {}) {
  if (surfaces.length === 0) return ['No plugins installed.']
  return surfaces.map(s => {
    const src = s.source ?? {}
    return (
      `${pad(s.id, 24)}${pad(src.version ?? '?', 10)}` +
      `${pad(`${src.repo ?? '?'}${src.subdir ? `#${src.subdir}` : ''}`, 56)}` +
      `${s.installedAt ?? '?'}${sidecarIds.includes(s.id) ? '  (local)' : ''}`
    ).trimEnd()
  })
}

// ---------------------------------------------------------------- the audit

/**
 * **`pnpm plugin check` is the agent's oracle, so every failure carries the EDIT.**
 *
 * It used to say what was wrong and stop there, which is right for a person with `reference.md`
 * open beside them and useless to an agent, who has only the line. Installs are performed by
 * agents as often as by people now — the same observation that retired "by hand" from the step
 * taxonomy above — so a diagnostic naming a problem without naming its fix is the same non-control
 * as a printed instruction nobody performs.
 *
 * One line: `<file>:<line> <what is wrong> — <the exact change>`. The line number is there
 * whenever the thing complained about is IN a file at a place (a manifest key), and absent when
 * the complaint is that a file, a test or an export does not exist at all: a fabricated line
 * number sends a reader somewhere real and wrong, which is worse than sending them nowhere.
 */
export function renderDiagnostic({ file, line = null, problem, fix }) {
  return `${line ? `${file}:${line}` : file} ${problem} — ${fix}`
}

/**
 * The 1-based line of `"a"."b"."c"` in a JSON source, or `null` when the path is not there.
 *
 * Textual rather than a parse, deliberately: `JSON.parse` throws position away, and the whole
 * point of this number is to put a cursor on the key somebody has to edit. It walks the path
 * FORWARDS, so `schema.tables` is found after the `"schema"` line rather than wherever the word
 * first appears, and it answers the deepest segment it reached — a partially present path still
 * points somewhere useful instead of nowhere.
 */
export function jsonKeyLine(source, keyPath) {
  const lines = String(source).split('\n')
  let from = 0
  let found = null
  for (const part of String(keyPath).split('.')) {
    const re = new RegExp(`"${escapeRe(part)}"\\s*:`)
    const at = lines.findIndex((l, i) => i >= from && re.test(l))
    if (at === -1) return found
    found = at + 1
    from = at
  }
  return found
}

const isStr = v => typeof v === 'string' && v.trim() !== ''
const isStrArray = v => Array.isArray(v) && v.every(x => typeof x === 'string')
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Every field of a plugin manifest that is missing, mistyped or unreadable — each naming the FIELD
 * and its legal values, never "invalid manifest".
 *
 * A manifest is the one file in a plugin that nothing else validates: the trees are typechecked,
 * the barrels are written by the tooling, the tables are migrated by the host. This is read with
 * `JSON.parse` and then indexed into, so a key spelled wrong is silence — and the silence surfaces
 * as a binding missing after a deploy, or a plugin nothing ever gates against a kit version.
 * `pluginPlatformProblems` owns the `bindings[]` half and is called from here, so a caller asks
 * once and gets one list.
 */
export function pluginManifestProblems(manifest) {
  const out = []
  const bad = (field, problem, fix) => out.push({ field, problem, fix })
  if (!isObj(manifest)) {
    bad('', 'is not a JSON object', 'the manifest is one object with an "id" at its top level')
    return out
  }
  const m = manifest

  const idProblem = pluginIdProblem(m.id)
  if (idProblem) {
    bad(
      'id',
      `has no usable id (${idProblem})`,
      `set "id" to a namespace matching ${PLUGIN_ID_RE.source}`
    )
  }

  if (m.version === undefined) {
    bad(
      'version',
      'declares no version',
      'add "version": "0.1.0" — defaultPlugins pins it and the surface is compared to it'
    )
  } else if (!(isStr(m.version) && /^\d+\.\d+\.\d+/.test(m.version))) {
    bad(
      'version',
      `declares version ${JSON.stringify(m.version)}`,
      'set "version" to "MAJOR.MINOR.PATCH"'
    )
  }

  for (const [field, label] of [
    ['repo', 'the git URL this plugin is fetched from again'],
    ['subdir', 'the directory inside that repository, or ""'],
    ['label', 'the human name the plan prints'],
    ['anchor', 'the manifest path inside a host'],
  ]) {
    if (m[field] !== undefined && typeof m[field] !== 'string') {
      bad(field, `declares ${field} as ${typeof m[field]}`, `set "${field}" to a string — ${label}`)
    }
  }
  if (typeof m.repo === 'string' && m.repo.trim() === '') {
    bad(
      'repo',
      'declares an empty repo',
      'set "repo" — a plugin nobody can fetch again cannot be upgraded'
    )
  }

  for (const field of ['paths', 'registries', 'apiPrefixes', 'workerExports', 'migrations']) {
    if (m[field] !== undefined && !isStrArray(m[field])) {
      bad(field, `declares ${field} as other than an array of strings`, `set "${field}" to []`)
    }
  }

  // **The floor, and the two fields it replaces.** A manifest still carrying `requires.kit` or
  // `requires.pluginApi` is a LOUD error naming the replacement, never a field quietly ignored:
  // both were PREDICTIONS, both went stale, and a manifest that still declares one was written
  // against a contract this kit no longer honours. Silence here would install it and let the
  // staleness surface later as something else entirely.
  if (m.minKit !== undefined && !isStr(m.minKit)) {
    bad('minKit', 'declares a non-string minKit', 'set "minKit" to a bare version like "0.8.0"')
  } else if (isStr(m.minKit) && !BARE_VERSION.test(m.minKit.trim())) {
    bad(
      'minKit',
      `declares minKit ${JSON.stringify(m.minKit)}, which is not a bare X.Y.Z version`,
      'set "minKit" to one version — it is a FLOOR, not a range: no >=, no ^, no ceiling'
    )
  } else if (m.minKit === undefined) {
    bad(
      'minKit',
      'declares no minKit',
      'add "minKit": "0.8.0" at the TOP level — the oldest kit release this plugin supports'
    )
  }
  // One spelling, and a misplaced one is loud. Reading both here would mean this and
  // `plugin-ci.yml` — which reads the top-level key alone — disagreed about the same manifest.
  if (isObj(m.requires) && m.requires.minKit !== undefined) {
    bad(
      'requires.minKit',
      'declares minKit under "requires"',
      'move it to the TOP level, beside "id" and "version" — that is the only place it is read'
    )
  }
  if (m.uses !== undefined && !isObj(m.uses)) {
    bad(
      'uses',
      'declares uses as other than an object',
      'set "uses" to { "<entry>": ["<symbol>"] } — derived, never hand-written: `pnpm plugin export` writes it'
    )
  } else {
    for (const [entry, names] of Object.entries(m.uses ?? {})) {
      if (!isStrArray(names)) {
        bad(
          'uses',
          `declares ${entry} as other than an array of symbol names`,
          `set "uses"."${entry}" to an array of the symbols this plugin imports from it`
        )
      }
    }
  }

  if (m.requires !== undefined && !isObj(m.requires)) {
    bad(
      'requires',
      'declares requires as other than an object',
      'set "requires" to { "surfaces": [], "plugins": [] }'
    )
  } else {
    const r = m.requires ?? {}
    if (r.kit !== undefined) {
      bad(
        'requires.kit',
        'declares requires.kit, a semver RANGE this kit no longer reads',
        'replace it with a top-level "minKit": "X.Y.Z" — one floor, no ceiling, no range language'
      )
    }
    if (r.pluginApi !== undefined) {
      bad(
        'requires.pluginApi',
        'declares requires.pluginApi, a contract version this kit no longer reads',
        'delete it — compatibility is now OBSERVED from "uses" against the kit\'s ledger (docs/plugin-api.md)'
      )
    }
    if (r.surfaces !== undefined && !isStrArray(r.surfaces)) {
      bad(
        'requires.surfaces',
        'declares surfaces as other than an array of strings',
        'set "requires.surfaces" to []'
      )
    }
    if (r.plugins !== undefined && !Array.isArray(r.plugins)) {
      bad(
        'requires.plugins',
        'declares plugins as other than an array',
        'set "requires.plugins" to []'
      )
    } else {
      for (const entry of r.plugins ?? []) {
        if (!isStr(entry) && !(isObj(entry) && isStr(entry.id))) {
          bad(
            'requires.plugins',
            `carries the entry ${JSON.stringify(entry)}`,
            'each entry is "<id>" or { "id": "<id>", "minVersion": "X.Y.Z" }'
          )
          continue
        }
        // The old range spellings, refused by name rather than parsed: `"<id>@<range>"` and a
        // `range` key are both range language, and a floor is the only thing read now.
        if (isStr(entry) && entry.includes('@')) {
          bad(
            'requires.plugins',
            `carries the entry ${JSON.stringify(entry)}, which pins a RANGE`,
            `write { "id": "${entry.split('@')[0]}", "minVersion": "X.Y.Z" } — a floor, not a range`
          )
          continue
        }
        if (isObj(entry) && entry.range !== undefined) {
          bad(
            'requires.plugins',
            `declares a range for '${entry.id}'`,
            `replace "range" with "minVersion": "X.Y.Z" — one floor, no ceiling`
          )
          continue
        }
        if (isObj(entry) && entry.minVersion !== undefined) {
          if (!isStr(entry.minVersion) || !BARE_VERSION.test(entry.minVersion.trim())) {
            bad(
              'requires.plugins',
              `declares minVersion ${JSON.stringify(entry.minVersion)} for '${entry.id}'`,
              'set "minVersion" to a bare X.Y.Z version'
            )
          }
        }
      }
    }
  }

  if (m.dependencies !== undefined && !isObj(m.dependencies)) {
    bad(
      'dependencies',
      'declares dependencies as other than an object',
      'set "dependencies" to { "apps/web": {} }'
    )
  } else {
    for (const [pkg, deps] of Object.entries(m.dependencies ?? {})) {
      if (!isObj(deps) || Object.values(deps).some(v => typeof v !== 'string')) {
        bad(
          'dependencies',
          `declares ${pkg} as other than a name → version map`,
          `set "dependencies"."${pkg}" to { "<package>": "<range>" }`
        )
      }
    }
  }

  if (m.bindings !== undefined && !Array.isArray(m.bindings)) {
    bad('bindings', 'declares bindings as other than an array', 'set "bindings" to []')
  } else {
    for (const b of m.bindings ?? []) {
      if (!isObj(b)) {
        bad(
          'bindings',
          `carries the entry ${JSON.stringify(b)}`,
          'each binding is { "type", "binding", … }'
        )
      }
    }
    for (const problem of pluginPlatformProblems(m)) {
      bad('bindings', problem, `supported types are ${SUPPORTED_PLUGIN_BINDING_TYPES.join(', ')}`)
    }
  }

  if (m.crons !== undefined && !Array.isArray(m.crons)) {
    bad('crons', 'declares crons as other than an array', 'set "crons" to []')
  } else {
    for (const c of m.crons ?? []) {
      const expression = isObj(c) ? c.cron : c
      if (!isStr(expression) || expression.trim().split(/\s+/).length !== 5) {
        bad(
          'crons',
          `carries the expression ${JSON.stringify(expression ?? c)}`,
          'a cron is five whitespace-separated fields ("15 * * * *") — the string the toml gets'
        )
      }
    }
  }

  if (m.vars !== undefined && !Array.isArray(m.vars)) {
    bad('vars', 'declares vars as other than an array', 'set "vars" to []')
  } else {
    for (const v of m.vars ?? []) {
      const key = isObj(v) ? (v.key ?? v.name) : v
      if (!isStr(key)) {
        bad(
          'vars',
          `carries the entry ${JSON.stringify(v)}`,
          'each var is { "key", "example"?, "secret"? }'
        )
        continue
      }
      if (isObj(v) && v.secret !== undefined && typeof v.secret !== 'boolean') {
        bad(
          'vars',
          `declares ${key} with a non-boolean secret`,
          `set ${key}'s "secret" to a boolean`
        )
      }
    }
  }

  if (m.schema !== undefined && !isObj(m.schema)) {
    bad(
      'schema',
      'declares schema as other than an object',
      'set "schema" to { "tables": [], "rlsExcluded": [] }'
    )
  } else {
    for (const field of ['tables', 'rlsExcluded']) {
      const value = m.schema?.[field]
      if (value !== undefined && !isStrArray(value)) {
        bad(
          `schema.${field}`,
          `declares ${field} as other than an array of strings`,
          `set "schema"."${field}" to []`
        )
      }
    }
  }

  if (m.coreEdits !== undefined && !Array.isArray(m.coreEdits)) {
    bad('coreEdits', 'declares coreEdits as other than an array', 'set "coreEdits" to []')
  } else {
    for (const e of m.coreEdits ?? []) {
      if (!isObj(e) || !isStr(e.file) || !isStr(e.after) || !isStrArray(e.lines)) {
        bad(
          'coreEdits',
          `carries the entry ${JSON.stringify(e)}`,
          'each edit is { "file", "after", "lines": [] } — anchored on text, never a line number'
        )
      }
    }
  }

  return out
}

/**
 * The value names a `worker-exports.ts` exports, and whether they can be known at all.
 *
 * `opaque` is an `export * from './x'`, whose names need the module resolved to enumerate. Both
 * directions of the worker-barrel check are skipped for one rather than guessed: reporting
 * "declares OrdersHub and does not export it" against a star re-export that plainly does would
 * teach an author to distrust the whole audit.
 */
export function workerExportNames(source) {
  const text = String(source)
  const names = new Set()
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim()
      if (spec === '' || spec.startsWith('type ')) continue
      const halves = spec.split(/\s+as\s+/)
      names.add((halves[1] ?? halves[0]).trim())
    }
  }
  const declaration =
    /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/g
  for (const m of text.matchAll(declaration)) names.add(m[1])
  names.delete('')
  return { names: [...names], opaque: /export\s+\*/.test(text) }
}

/**
 * A source with its comments removed.
 *
 * **Shared by every check that SCANS source**, because the failure mode is one and it is
 * invisible: a check a comment can talk its way past reports SUCCESS. The fixture written to prove
 * the `onTenantDeleted` rule carried the sentence "declares no `hooks.onTenantDeleted`" in its own
 * doc comment and passed on it; a test file whose header says "tenant isolation" would have
 * satisfied the isolation check the same way. Prose about a rule is not the rule being kept.
 */
function stripComments(source) {
  return (
    String(source)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // `[^:]` so a `https://…` inside a string is not mistaken for a line comment.
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  )
}

/**
 * Structural evidence that a test file proves cross-tenant isolation.
 *
 * **This proves a test EXISTS, not that it is right**, and the diagnostic says so. A structural
 * check cannot read a predicate — but it does not have to be alone: `@testkit`'s builders refuse a
 * fake `db` (they require a handle blessed by `setupTestDatabase`, tracked in a `WeakSet` rather
 * than by shape), so the cheap wrong version — a stub answering `[]` to "tenant B sees no rows" —
 * is already hard to write. Two signals together, because either alone is noise: the file must
 * CREATE at least two organisations, and it must NAME the second one or the property.
 */
export function isolationEvidence(source) {
  // Comments stripped FIRST: a commented-out `createTestTenant(db)`, or a header paragraph about
  // tenant isolation, is talk about the test rather than the test.
  const text = stripComments(source)
  const named = /describe\(\s*['"`][^'"`]*isolation/i.test(text)
  // No word boundary AFTER `tenant`: the usual spelling is `otherTenantId` / `otherTenantCookie`,
  // and a trailing `\b` refuses every one of them.
  const secondTenant = /\b(?:other|second|another|foreign)[A-Za-z]*[Tt]enant|\btenantB\b/.test(text)
  const tenantsCreated = [...text.matchAll(/createTestTenant(?:WithUser)?\s*\(/g)].length
  return { named, secondTenant, tenantsCreated, ok: tenantsCreated >= 2 && (named || secondTenant) }
}

/**
 * Whether a TypeScript source really DECLARES `name` as a property or method, rather than merely
 * mentioning it.
 *
 * Comments are stripped first, and that is not belt-and-braces: the fixture written to prove the
 * `onTenantDeleted` check works carried the sentence *"declares no `hooks.onTenantDeleted`"* in its
 * own doc comment, and a substring search was satisfied by it. A check a comment can talk its way
 * past is worse than no check, because it reports success.
 */
export function declaresProperty(source, name) {
  return new RegExp(`\\b${escapeRe(name)}\\s*[:(]`).test(stripComments(source))
}

/**
 * Where an install's `subdir` comes from, in precedence order: the flag somebody typed, then the
 * manifest, then where the source was opened.
 *
 * **`||` and not `??`, and that is the whole function.** Nullish-coalescing falls through only on
 * `null`/`undefined`, so a manifest shipping `"subdir": ""` — which every root-level plugin does —
 * BEAT an explicit `--subdir`, and the surface was recorded as root-relative. Nothing fails at
 * install; it fails at the next `pnpm plugin upgrade`, which diffs and applies against that path
 * and finds the plugin nowhere. Hit for real installing from a monorepo.
 */
export function resolveSubdir({ flag = null, manifest = null, source = null } = {}) {
  const trim = v => (typeof v === 'string' ? v.replace(/^\/+|\/+$/g, '') : '')
  return trim(flag) || trim(manifest) || trim(source) || ''
}

/** The range a package is pinned at in a host `package.json`, either section, or null. */
const rangeIn = (json, name) => json?.dependencies?.[name] ?? json?.devDependencies?.[name] ?? null

/**
 * Declared dependencies that are not in the host package's `package.json`, or are at another range.
 *
 * **Nothing checked this, and both halves fail silently.** `plugin add --apply` really runs
 * `pnpm --dir <pkg> add <name>@<range>`, so a plugin whose install failed part-way — or whose
 * dependency was dropped later by `remove`, which deliberately only PRINTS `pnpm remove` — reports
 * as perfectly healthy while its imports cannot resolve. `have: null` is the missing case and is a
 * failure; a different range is reported separately, because the host's `package.json` is listed
 * under `manual` in `.rocketflare.json` and an operator is entitled to have pinned it themselves.
 */
export function missingDependencies(manifest, packageJsons = {}) {
  const out = []
  for (const [pkg, deps] of Object.entries(manifest?.dependencies ?? {})) {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const have = rangeIn(packageJsons[pkg], name)
      if (have === null) out.push({ pkg, name, range, have: null })
      else if (have !== range) out.push({ pkg, name, range, have })
    }
  }
  return out
}

/**
 * A dependency this plugin wants at a range the host, or another installed plugin, already has
 * pinned differently.
 *
 * **`pnpm add` silently overwrites the range in the host's `package.json`**, so two plugins wanting
 * different majors of one package is last-install-wins with nothing said — at the exact moment
 * somebody is being asked to approve an install that carries full Worker and database access. And
 * `package.json` is `manual` in `.rocketflare.json`, so no kit upgrade ever reconciles it for
 * anyone afterwards.
 *
 * It WARNS rather than refusing, and the reason is not timidity: a clash is very often the intended
 * change — a plugin that legitimately needs a newer major of a shared package is how a dependency
 * moves forward at all — so refusing would make an ordinary upgrade impossible without editing
 * somebody else's manifest. What it must not be is quiet, so it is surfaced as a **human** step,
 * where the taxonomy already makes a decision structurally unmissable rather than a sentence in a
 * paragraph.
 */
export function dependencyClashes(manifest, { packageJsons = {}, installed = [] } = {}) {
  const out = []
  for (const [pkg, deps] of Object.entries(manifest?.dependencies ?? {})) {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const hostRange = rangeIn(packageJsons[pkg], name)
      if (hostRange && hostRange !== range) {
        out.push({ pkg, name, range, holder: `${pkg}/package.json`, theirs: hostRange })
      }
      for (const other of installed) {
        if (other.id === manifest.id) continue
        const theirs = other.dependencies?.[pkg]?.[name]
        if (theirs && theirs !== range) {
          out.push({ pkg, name, range, holder: `the '${other.id}' plugin`, theirs })
        }
      }
    }
  }
  return out
}

/** One clash as the sentence both the plan and `--json` show. */
export const describeClash = c =>
  `${c.pkg}: ${c.name} — this plugin wants ${c.range}, ${c.holder} has ${c.theirs}`

/**
 * Tables that two installed plugins both declare.
 *
 * **This is the only part of the table-naming rule that is mechanical, and it is the only part that
 * has to be.** The prefix convention — every table starting with the first hyphen-separated segment
 * of the plugin's id — is a convention a human picks: nothing anywhere derives a table name from an
 * id or an id from a table name, so there is no key to check a shape against. What CAN be checked,
 * and what actually breaks a host, is two plugins claiming one name.
 *
 * **Nothing else sees it.** `db/schema/index.ts` answers TS2308 for a duplicated EXPORT NAME, which
 * is a different fault: two plugins spelling `pgTable('orders', …)` under the symbols `orders` and
 * `orderRows` compile cleanly, and then drizzle-kit emits DDL for one name twice, `rls-coverage`
 * reads one policy as covering both, and `pnpm plugin remove` takes the other plugin's table with
 * it — `archiveSql` and the generated `DROP TABLE` both name the table verbatim, so neither can
 * tell whose it is.
 *
 * It fails whoever is installed, and it always did: the audit's old two tiers asked "can a plugin
 * released before this rule existed retroactively satisfy it", and neither plugin here is
 * non-compliant on its own. The fault is in the COMBINATION, and the host cannot run it either way.
 *
 * One entry per plugin involved, so every finding is filed against a manifest somebody can edit.
 */
export function tableClashes(manifests = []) {
  const holders = new Map()
  for (const m of manifests) {
    if (!m?.id) continue
    for (const table of m.schema?.tables ?? []) {
      if (typeof table !== 'string' || table.trim() === '') continue
      const ids = holders.get(table) ?? []
      if (!ids.includes(m.id)) ids.push(m.id)
      holders.set(table, ids)
    }
  }
  const out = []
  for (const [table, ids] of [...holders].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.length < 2) continue
    for (const id of [...ids].sort()) {
      out.push({ table, id, others: ids.filter(other => other !== id).sort() })
    }
  }
  return out
}
