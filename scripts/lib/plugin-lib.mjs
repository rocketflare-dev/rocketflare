/**
 * The pure half of `scripts/plugin.mjs` (D31, Phase B): the plugin id rules, the five barrel
 * lines, the file-root classification, the requirement check, the surface builder and the plan
 * text. No I/O and nothing runs at import time, so `apps/web/tests/config/plugin-lib.test.ts` can
 * drive every rule against a FIXTURE — which matters because most of them are rules about a plugin
 * this checkout does not have installed.
 *
 * The barrel writer is the part to read twice. Installing a plugin IS five lines; if this file
 * writes them differently from the way a person would, every install produces a lint diff and the
 * gate stops passing by construction. So it inserts in sorted order, it is idempotent (running
 * `add` twice writes nothing), and `remove` is its exact inverse — the test asserts the round trip
 * returns the original bytes.
 *
 * `plugin-lib.d.mts` beside this file is the hand-written type surface (no `allowJs`).
 */
import { KIT } from './rename-lib.mjs'
import { satisfies } from './upgrade-lib.mjs'

// ---------------------------------------------------------------- identity

/** The same rule `@rocketflare/shared/plugins` enforces at the type level. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/

/** Barrel FILENAMES. An id that collides with one makes `./<id>` ambiguous with a barrel import. */
export const RESERVED_PLUGIN_IDS = Object.freeze(['index', 'server', 'ui', 'schema', 'types'])

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

// ---------------------------------------------------------------- the five barrels

/**
 * The five barrel lines, as data. `half` is the file under the plugin's tree whose PRESENCE means
 * the plugin ships that half — an install writes a line only for the halves that arrived, so a
 * plugin with no CLI command does not get a CLI import of a file that is not there.
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
    // typechecking. The other four barrels always declare a const, so only this one needs it.
    empty: 'export {}',
    specifier: id => `./${id}/db/schema`,
    half: id => `apps/web/src/plugins/${id}/db/schema/index.ts`,
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

/** `exampleFeatureServer`, and so on. `null` for the schema barrel, which exports no name. */
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

  const existing = pluginImports(text)
  const lines = text.split('\n')
  if (existing.length === 0) {
    // No plugin installed yet. A list barrel always has an `import type … from './types'`, and
    // Biome sorts value imports above it; the schema barrel has no imports at all, so its one line
    // goes after the last non-empty line of the header comment.
    const anchor = lines.findIndex(l => l.startsWith('import type '))
    const lastText = lines.reduce((acc, l, i) => (l.trim() === '' ? acc : i), 0)
    lines.splice(anchor === -1 ? lastText + 1 : anchor, 0, newLine)
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
 * `scripts/` is on this list because a plugin repository needs the kit's `release.mjs` and the four
 * `lib/*.mjs` it imports in order to cut a release at all (there is no `pnpm plugin:release`; the
 * skill tells an author to copy them in). They are the plugin repo's OWN tooling in exactly the
 * sense `.github/` is — and without this entry the first real plugin was refused at install for
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
 * The binding types provisioning knows how to create (D31, decision 12).
 *
 * **This list exists twice and the duplication is pinned, not silent.**
 * `apps/web/scripts/provision/plugin-resources.ts` owns the TypeScript half and is what
 * `pnpm provision cloudflare <env>` reads; this is the `.mjs` half, because `scripts/plugin.mjs`
 * runs under plain Node and cannot import a `.ts` module. `plugin-lib.test.ts` asserts the two are
 * identical, so narrowing or widening one without the other fails the suite. Checking it HERE is
 * what makes an unsupported type stop an INSTALL, rather than surface as a 503 on the first
 * request after a deploy that silently skipped the binding.
 */
export const SUPPORTED_PLUGIN_BINDING_TYPES = Object.freeze(['kv', 'queue', 'r2'])

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
    if (!SUPPORTED_PLUGIN_BINDING_TYPES.includes(b.type)) {
      problems.push(
        `binding ${b.binding ?? b.name ?? '?'} declares type '${b.type}', which provisioning cannot ` +
          `create (supported: ${SUPPORTED_PLUGIN_BINDING_TYPES.join(', ')})`
      )
    }
  }
  return problems
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
  kitVersion,
  presentSurfaces = [],
  installedPlugins = [],
  vendored = false,
}) {
  const problems = []
  const range = requires.kit
  if (range && !vendored && !satisfies(kitVersion, range)) {
    problems.push(`kit ${kitVersion} does not satisfy ${range}`)
  }
  for (const id of requires.surfaces ?? []) {
    if (!presentSurfaces.includes(id)) problems.push(`surface '${id}' is not present in this app`)
  }
  for (const req of requires.plugins ?? []) {
    const { id, range: r } = parsePluginRequirement(req)
    const found = installedPlugins.find(p => p.id === id)
    if (!found) problems.push(`plugin '${id}' is required and not installed`)
    else if (r && !satisfies(found.version ?? '0.0.0', r)) {
      problems.push(
        `plugin '${id}' is ${found.version ?? 'unversioned'}, which does not satisfy ${r}`
      )
    }
  }
  return problems
}

/**
 * The installed plugins a move to kit `version` would leave unsupported.
 *
 * Shared by `plugin add|check` and by `kit:upgrade` because it has to answer the same, and once did
 * not: `plugin check` printed "vendored — requires.kit is not checked" and exited 0 while
 * `kit:upgrade`, in the same checkout, refused with exit 6 over the same range. A VENDORED plugin
 * ships inside the kit, so its range describes the kit it came out of rather than a compatibility
 * claim about a kit it has never seen — the release that moves the kit moves it too.
 */
export function unsupportedForKit(plugins, { kitRepo, version }) {
  if (!version) return []
  return plugins.filter(
    p => p.requires?.kit && !isVendored(p.source, kitRepo) && !satisfies(version, p.requires.kit)
  )
}

/** `"approvals@>=1.0.0 <2.0.0"` → `{ id, range }`; a bare id has a null range. */
export function parsePluginRequirement(entry) {
  if (typeof entry === 'object' && entry !== null)
    return { id: entry.id, range: entry.range ?? null }
  const at = String(entry).indexOf('@')
  return at === -1
    ? { id: String(entry), range: null }
    : { id: entry.slice(0, at), range: entry.slice(at + 1) }
}

/** True when this plugin ships inside the kit itself (`example-feature` is the one that does). */
export function isVendored(source, kitRepo) {
  return Boolean(source && source.repo === kitRepo && (source.subdir ?? '') === '')
}

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
    requires: {
      kit: manifest.requires?.kit ?? '*',
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
    lines.push(
      `  ✔ kit ${plan.host.kitVersion} satisfies ${m.requires?.kit ?? '*'}` +
        (plan.vendored ? ' (vendored — shipped with the kit, so the range is not checked)' : ''),
      `  ✔ surfaces: ${(m.requires?.surfaces ?? []).join(', ') || 'none required'}`,
      `  ✔ plugins:  ${(m.requires?.plugins ?? []).join(', ') || 'none required'}`
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

  lines.push('', 'Then, by hand — nothing below is done for you')
  let n = 0
  const step = line => lines.push(`  ${++n}. ${line}`)
  if ((m.schema?.tables ?? []).length > 0) {
    step(
      `pnpm db:generate --name plugin-${m.id}-${m.version ?? '0.0.0'}   → CREATE TABLE ` +
        `${m.schema.tables.join(', ')}; read the SQL, then pnpm db:migrate`
    )
  }
  if (fragments.length > 0) {
    step(
      `pnpm db:generate --custom --name plugin-${m.id}-install, then paste ` +
        `${fragments.map(f => f.path).join(', ')} into it`
    )
  }
  // The platform half is one command per environment, not a hand edit of two tomls (decision 12):
  // `pnpm provision cloudflare <env>` reads these same declarations off the installed surface,
  // creates the resources and writes the blocks into BOTH files.
  const platform = [
    ...(m.bindings ?? []).map(b => `${b.type} binding ${b.binding ?? b.name}`),
    ...(m.crons ?? []).map(c => `cron "${c.cron ?? c}"`),
    ...(m.apiPrefixes ?? []).map(p => `route prefix ${p}`),
    ...(m.vars ?? []).filter(v => !v.secret).map(v => `[vars] ${v.key ?? v.name ?? v}`),
  ]
  if (platform.length > 0) {
    step(
      'run `pnpm provision cloudflare <env>` for each environment — it creates and writes ' +
        `${platform.join(', ')} into BOTH tomls`
    )
  }
  for (const v of (m.vars ?? []).filter(v => v.secret)) {
    const key = v.key ?? v.name ?? v
    // A secret never goes in a toml — not even the staging one — so this is its own sentence
    // rather than a parenthesis on the one above.
    step(
      `add \`${key}=\` to apps/web/.dev.vars.example and apps/web/.dev.vars, then ` +
        `run \`pnpm provision secrets <env>\` — a secret is never a [vars] key`
    )
  }
  for (const e of m.workerExports ?? []) {
    step(`export { ${e} } from its plugin in apps/web/src/worker.ts (a DO or Workflow class)`)
  }
  step('pnpm lint && pnpm typecheck && pnpm test && pnpm build')

  if (plan.verify) lines.push('', "Verify (from the plugin's own note)", ...indent(plan.verify))
  return lines
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
