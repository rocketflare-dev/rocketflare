#!/usr/bin/env node
/**
 * Install, upgrade, remove and audit plugins (D31, `docs/CONCEPTS.md` §16).
 *
 *   node scripts/plugin.mjs add <repo|path>[@ref] [--subdir <dir>] [--apply] [--local]
 *   node scripts/plugin.mjs upgrade <id> [--to <ref>] [--from <ref>] [--apply]
 *   node scripts/plugin.mjs remove <id> [--apply] [--archive]
 *   node scripts/plugin.mjs list | check | export <id> <dir>
 *
 * A plugin is a separate git repository COPIED into an app — never installed from npm, exactly
 * like the kit itself — so this script is the kit-upgrade machine pointed at a second kind of
 * repository: mirror, read the notes, classify every path, translate through the same token map
 * the rename used, write artifacts, and only then apply. `scripts/lib/git-lib.mjs` is that shared
 * pipeline and `scripts/lib/plugin-lib.mjs` is the pure half (the barrel lines, the file-root
 * rules, the plan text).
 *
 * Three things it will not do, each because the alternative is silent damage:
 *
 *   - **never copy a migration.** A snapshot describes a whole cumulative schema, so importing a
 *     foreign one teaches drizzle a current state that has never heard of the host's own tables.
 *     The host generates its own with `pnpm db:generate` once the schema barrel line exists.
 *   - **never write a resource id or edit a wrangler toml.** A binding a plugin declares is
 *     REPORTED; `pnpm provision cloudflare <env>` is what creates it.
 *   - **never apply without being asked.** Every command prints its plan and stops; `--apply` is a
 *     second, deliberate run, which is the whole of decision 1's "installing a plugin is as
 *     trusting as merging a pull request".
 *
 * Exit 0 ok · 1 error · 2 usage · 3 unreachable with no cached mirror · 4 applied with rejects
 * (work remains, not a failure) · 5 no plugin manifest at the source · 6 a requirement is unmet ·
 * 7 the target path already exists. Zero dependencies, Node ≥ 24.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectChanges,
  dirtyTree,
  ensureMirror,
  makeGit,
  makeWriter,
  mirrorDirFor,
  notesBetween,
  PLUGIN_MIRROR_ROOT,
} from './lib/git-lib.mjs'
import { pluginSurfaces, readManifest } from './lib/manifest.mjs'
import {
  addBarrelLine,
  addPlanJson,
  applyCoreEdits,
  archiveSql,
  BARREL_KINDS,
  BARRELS,
  barrelLines,
  buildPluginSurface,
  checkRequirements,
  classifyPluginFile,
  coreEditsByFile,
  declaresProperty,
  dependencyClashes,
  describeClash,
  floorOf,
  hasBarrelLine,
  isolationEvidence,
  isVendored,
  jsonKeyLine,
  missingDependencies,
  nextPluginMigrationTag,
  PLUGIN_MANIFEST_FILE,
  parsePluginRequirement,
  pluginIdProblem,
  pluginManifestProblems,
  pluginPlatformProblems,
  pluginRoots,
  removeBarrelLine,
  removeSteps,
  renderAddPlan,
  renderDiagnostic,
  renderList,
  renderSteps,
  resolveSubdir,
  revertCoreEdits,
  surfaceDirectories,
  tableClashes,
  workerExportNames,
} from './lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, isBinary } from './lib/rename-lib.mjs'
import { missingFrom, readLedger, usesOf } from './lib/surface.mjs'
import {
  compareVersions,
  countLines,
  parseNote,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from './lib/upgrade-lib.mjs'

/** A bare `X.Y.Z`. There is no range language left anywhere in the plugin lifecycle. */
const BARE_VERSION = /^\d+\.\d+\.\d+$/

/**
 * The kit's ledger, or a deliberate stop.
 *
 * `readLedger` answers null for three legitimate absences, and **a caller that treats null as "
 * nothing is missing" has disabled its own check** — so every caller here turns it into a refusal
 * that names the fix instead.
 */
function requireLedger() {
  const ledger = readLedger(REPO_ROOT)
  if (!ledger) {
    stop(
      1,
      'error: docs/plugin-api.md carries no surface ledger, so there is nothing to check a plugin',
      'against. Run `node scripts/plugin-api-doc.mjs` and commit what it writes.'
    )
  }
  return ledger
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The mirror location is shared with `scripts/release.mjs`, which fetches the same plugin
// repositories to read their manifests — one clone, not two that take turns being stale.
const WORK_DIR = PLUGIN_MIRROR_ROOT

const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}
const abs = rel => path.join(REPO_ROOT, rel)
const { git, quiet: gitQuiet } = makeGit(REPO_ROOT)

export const USAGE = `usage: node scripts/plugin.mjs <command> [options]

  add <repo|path>[@ref]   install a plugin. A PATH is read directly (the authoring loop); a repo
                          is mirrored under ${WORK_DIR}/. Prints the plan and stops.
    --subdir <dir>        the plugin lives in a subdirectory of that repository
    --apply               actually install it: copy, write the five barrel lines, add dependencies
                          and record the surface
    --local               record it in the git-ignored .rocketflare.local.json sidecar rather than
                          in .rocketflare.json (implied in the kit itself)
    --no-fetch            use the cached mirror as-is (offline)
    --allow-dirty         install onto a tree with uncommitted changes

  upgrade <id>            port the plugin's own later releases in, exactly as \`pnpm kit:upgrade\`
    --to <ref> / --from <ref> / --apply / --no-fetch / --allow-dirty

  remove <id>             uninstall: delete its directories, its barrel lines and its surface
    --apply / --allow-dirty
    --archive             first write a --custom migration copying its tables into schema 'archive'

  list                    the installed plugins, one line each
  check                   audit every installed plugin; one line per failure, exit 1 on any

  export <id> <dir>       copy a plugin back out into a plugin repository checkout (authoring)

  --json                  on add, remove and check: the same facts as DATA rather than prose.
                          Every step carries its kind — agent (a command plus the assertion that
                          proves it) or human (a decision the tooling stops for) — so a human step
                          is a field rather than a sentence somebody has to notice.

  -h, --help

Exit 0 ok · 1 error · 2 usage · 3 unreachable with no cached mirror · 4 applied with rejects ·
5 no ${PLUGIN_MANIFEST_FILE} at the source · 6 a requirement is unmet · 7 the target path exists.`

export function parseArgs(argv) {
  const args = {
    command: null,
    positional: [],
    subdir: null,
    to: null,
    from: null,
    apply: false,
    local: false,
    archive: false,
    fetch: true,
    allowDirty: false,
    json: false,
  }
  const takesValue = { '--subdir': 'subdir', '--to': 'to', '--from': 'from' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return { help: true }
    if (a in takesValue) {
      const v = argv[++i]
      if (!v || v.startsWith('-')) return { error: `${a} needs a value` }
      args[takesValue[a]] = v
      continue
    }
    if (a === '--apply') args.apply = true
    else if (a === '--local') args.local = true
    else if (a === '--archive') args.archive = true
    else if (a === '--no-fetch') args.fetch = false
    else if (a === '--allow-dirty') args.allowDirty = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('-')) return { error: `unknown option '${a}'` }
    else if (!args.command) args.command = a
    else args.positional.push(a)
  }
  if (!args.command) return { error: 'a command is required' }
  return args
}

/** Thrown for every deliberate stop, so `main` has one exit path. */
class Stop extends Error {
  constructor(code, lines) {
    super(lines[0] ?? 'stopped')
    this.code = code
    this.lines = lines
  }
}
const stop = (code, ...lines) => {
  throw new Stop(code, lines)
}

// ---------------------------------------------------------------- the host

/** Everything about THIS checkout a command needs, read once. */
function loadHost() {
  const { manifest, isKit, sidecar, manifestPath, sidecarPath } = readManifest(REPO_ROOT)
  if (!manifest) {
    stop(
      1,
      'error: .rocketflare.json not found — a plugin is recorded as a surface in it, so there is',
      'nowhere to record one. Run this from the root of a copy of the kit.'
    )
  }
  const kitVersion = JSON.parse(readFileSync(abs('package.json'), 'utf8')).version
  const names = manifest.app
    ? deriveNames(manifest.app.slug, manifest.app.display, { domain: manifest.app.domain })
    : null
  const tracked = git(['ls-files']).trim().split('\n')
  return {
    manifest,
    isKit,
    sidecar,
    manifestPath,
    sidecarPath,
    kitVersion,
    names,
    tracked,
    label: manifest.app ? `${manifest.app.display} (${manifest.app.slug})` : 'the kit itself',
    kitRepo: manifest.kit.repo,
    plugins: pluginSurfaces(manifest),
    sidecarIds: (sidecar?.surfaces ?? []).map(s => s.id),
    presentSurfaces: manifest.surfaces.filter(s => existsSync(abs(s.anchor))).map(s => s.id),
  }
}

/** A host workspace package's `package.json`, or null. Never throws: a caller is reporting. */
function readHostPackageJson(pkg) {
  const file = abs(path.join(pkg, 'package.json'))
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The same file as TEXT, so a diagnostic can name the line a range actually sits on. */
const readHostPackageJsonSource = pkg => {
  const file = abs(path.join(pkg, 'package.json'))
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The host `package.json` of every workspace package a manifest's `dependencies` names. */
const packageJsonsFor = manifest =>
  Object.fromEntries(
    Object.keys(manifest?.dependencies ?? {}).map(pkg => [pkg, readHostPackageJson(pkg)])
  )

/** Each installed plugin's OWN declared dependencies, for peer-clash detection. */
function installedDependencyDeclarations(host) {
  return host.plugins
    .filter(p => existsSync(abs(p.anchor)))
    .map(p => {
      try {
        const m = JSON.parse(readFileSync(abs(p.anchor), 'utf8'))
        return { id: p.id, dependencies: m.dependencies ?? {} }
      } catch {
        return { id: p.id, dependencies: {} }
      }
    })
}

function requireClean(host, args) {
  if (args.allowDirty) return
  const dirty = dirtyTree(REPO_ROOT)
  if (dirty !== '') {
    stop(
      1,
      'error: the git tree is not clean — commit or stash first so the install is one reviewable',
      'diff (or pass --allow-dirty). `git status --short` shows:',
      dirty
    )
  }
}

/**
 * Write `.rocketflare.json` (or the sidecar) back.
 *
 * `JSON.stringify` does not produce the bytes Biome wants — it never collapses a short array onto
 * one line — so the committed manifest is re-formatted afterwards, or the very commit an install
 * produces fails `pnpm lint`. The sidecar is git-ignored, so Biome skips it (`useIgnoreFile`) and
 * plain JSON is correct there.
 */
function writeManifestFile(file, data, { format }) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  if (!format) return
  const r = spawnSync(
    'pnpm',
    ['exec', 'biome', 'format', '--write', path.relative(REPO_ROOT, file)],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  )
  if (r.status !== 0) {
    warn(
      `note: could not run Biome on ${path.basename(file)} — run \`pnpm lint:fix\` before committing`
    )
  }
}

/** Add or replace a plugin surface, in the manifest or the sidecar. Returns the file written. */
function recordSurface(host, surface, { local }) {
  if (local) {
    const sidecar = host.sidecar ?? { surfaces: [] }
    sidecar.surfaces = [...(sidecar.surfaces ?? []).filter(s => s.id !== surface.id), surface]
    writeManifestFile(host.sidecarPath, sidecar, { format: false })
    return host.sidecarPath
  }
  const raw = JSON.parse(readFileSync(host.manifestPath, 'utf8'))
  raw.surfaces = [...raw.surfaces.filter(s => s.id !== surface.id), surface]
  writeManifestFile(host.manifestPath, raw, { format: true })
  return host.manifestPath
}

function dropSurface(host, id) {
  const written = []
  if (host.sidecarIds.includes(id)) {
    const sidecar = { ...host.sidecar, surfaces: host.sidecar.surfaces.filter(s => s.id !== id) }
    writeManifestFile(host.sidecarPath, sidecar, { format: false })
    written.push(host.sidecarPath)
  }
  const raw = JSON.parse(readFileSync(host.manifestPath, 'utf8'))
  if (raw.surfaces.some(s => s.id === id)) {
    raw.surfaces = raw.surfaces.filter(s => s.id !== id)
    writeManifestFile(host.manifestPath, raw, { format: true })
    written.push(host.manifestPath)
  }
  return written
}

const findSurface = (host, id) => {
  const surface = host.plugins.find(s => s.id === id)
  if (!surface) {
    stop(
      1,
      `error: no plugin '${id}' is installed. \`pnpm plugin list\` shows:`,
      ...renderList(host.plugins, { sidecarIds: host.sidecarIds }).map(l => `  ${l}`)
    )
  }
  return surface
}

// ---------------------------------------------------------------- the source

const pluginMirrorDir = repo => mirrorDirFor(repo, abs(WORK_DIR))

/** `<repo|path>[@ref]`, without mistaking the `@` of `git@github.com:…` for a ref. */
export function splitRef(spec) {
  if (existsSync(spec)) return { target: spec, ref: null }
  const at = spec.lastIndexOf('@')
  const tail = spec.slice(at + 1)
  if (at > 0 && !tail.includes('/') && !tail.includes(':')) {
    return { target: spec.slice(0, at), ref: tail }
  }
  return { target: spec, ref: null }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.wrangler', '.upgrade'])

function walk(root, prefix = '') {
  const found = []
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) found.push(...walk(root, rel))
    } else if (entry.isFile()) found.push(rel)
  }
  return found.sort()
}

/**
 * A plugin's tree, from a working directory or from a bare mirror, behind one seam:
 * `{ files(), read(rel), repo, ref, commit }` with `read` answering BYTES.
 *
 * A local path is read directly and never mirrored — that is the authoring loop
 * (`pnpm plugin add ../rocketflare-plugin-approvals --local`, edit in place, `plugin export`), and
 * a mirror there would serve the last commit rather than the edit being tested.
 */
function openSource(spec, args) {
  const { target, ref } = splitRef(spec)
  const subdir = (args.subdir ?? '').replace(/^\/|\/$/g, '')
  if (existsSync(target) && statSync(target).isDirectory()) {
    const root = path.resolve(target, subdir)
    if (!existsSync(root)) stop(1, `error: ${root} does not exist`)
    const { quiet } = makeGit(path.resolve(target))
    const head = quiet(['rev-parse', 'HEAD'])
    return {
      kind: 'local',
      origin: path.resolve(target),
      remote: quiet(['remote', 'get-url', 'origin']).out.trim() || null,
      subdir,
      ref: ref ?? null,
      commit: head.ok ? head.out.trim() : null,
      files: () => walk(root),
      read: rel => readFileSync(path.join(root, rel)),
      has: rel => existsSync(path.join(root, rel)),
    }
  }
  const m = ensureMirror(target, pluginMirrorDir(target), {
    fetch: args.fetch,
    cwd: REPO_ROOT,
    warn,
  })
  const at = ref ?? m.latestTag() ?? 'HEAD'
  if (!m.resolves(at)) stop(1, `error: '${at}' is not in ${target}`)
  const full = p => (subdir === '' ? p : `${subdir}/${p}`)
  return {
    kind: 'git',
    origin: target,
    remote: target,
    subdir,
    ref: at,
    commit: m.commitOf(at),
    mirror: m,
    files: () => m.listFiles(at, subdir).map(p => (subdir === '' ? p : p.slice(subdir.length + 1))),
    read: rel => m.showRaw(at, full(rel)),
    has: rel => m.tryShow(at, full(rel)).ok,
  }
}

/** Bytes → the text that lands in the host, translated when the host has been renamed. */
function materialise(buffer, names) {
  if (isBinary(buffer)) return buffer
  const text = buffer.toString('utf8')
  return names ? applyReplacements(text, names).text : text
}

function writeInto(rel, content) {
  const file = abs(rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// ---------------------------------------------------------------- add

/** The "## Verify" section of the note that matches this version, or of the newest one. */
function verifyText(source, version) {
  const candidates = source.has(`docs/upgrades/${version}.md`)
    ? [`docs/upgrades/${version}.md`]
    : []
  for (const f of source.files()) {
    if (/^docs\/upgrades\/\d+\.\d+\.\d+\.md$/.test(f) && !candidates.includes(f)) candidates.push(f)
  }
  for (const f of candidates.slice(0, 1)) {
    const parsed = parseNote(source.read(f).toString('utf8'))
    const body = parsed?.body.split('## Verify')[1]?.trim()
    if (body) return body
  }
  return null
}

function cmdAdd(args, host) {
  const spec = args.positional[0]
  if (!spec) stop(2, 'error: add needs a repository or a path', '', USAGE)
  if (args.apply) requireClean(host, args)

  const source = openSource(spec, args)
  if (!source.has(PLUGIN_MANIFEST_FILE)) {
    stop(
      5,
      `error: no ${PLUGIN_MANIFEST_FILE} at ${source.origin}${source.subdir ? `/${source.subdir}` : ''}` +
        `${source.ref ? ` (${source.ref})` : ''}.`,
      'That file is what makes a repository a plugin: it declares the id, the version, the oldest',
      'kit it supports (minKit), the host surface it uses, and everything the host has to place',
      'for it (bindings, crons, vars).'
    )
  }
  const m = JSON.parse(source.read(PLUGIN_MANIFEST_FILE).toString('utf8'))
  const idProblem = pluginIdProblem(m.id)
  if (idProblem) stop(1, `error: ${idProblem}`)
  const repo = m.repo ?? source.remote
  if (!repo) {
    stop(
      1,
      `error: ${PLUGIN_MANIFEST_FILE} declares no "repo", and ${source.origin} has no git remote.`,
      'A plugin you cannot fetch again cannot be upgraded, so the surface has nowhere to point.'
    )
  }
  // The flag somebody TYPED wins over the manifest, which wins over where the source was opened.
  // `??` here read the manifest first and fell through only on nullish — so a plugin shipping
  // `"subdir": ""`, which every root-level plugin does, beat an explicit `--subdir` and recorded a
  // root-relative surface. Nothing failed at install; the next `plugin upgrade` diffed against that
  // path and found the plugin nowhere.
  const subdir = resolveSubdir({ flag: args.subdir, manifest: m.subdir, source: source.subdir })
  const vendored = isVendored({ repo, subdir }, host.kitRepo)

  // Every path, and the refusal that is the whole point of classifying them.
  const files = source.files().map(p => ({ path: p, ...classifyPluginFile(p, m.id) }))
  const refused = files.filter(f => f.role === 'refused')
  if (refused.length > 0) {
    stop(
      1,
      `error: ${refused.length} file(s) in this plugin write outside its own roots:`,
      ...refused.map(f => `  ${f.path}`),
      '',
      `A plugin owns ${pluginRoots(m.id).join(', ')} and nothing else — that is what makes an`,
      'install reversible by deleting a directory. This is a bug in the plugin, not in your tree.'
    )
  }

  // A binding type provisioning cannot create is refused HERE rather than at `provision
  // cloudflare`, which runs days later and for somebody else: a plugin declaring one would install
  // cleanly, deploy, and 503 on its first request to whatever reads it off `Cloudflare.Env`.
  const platformProblems = pluginPlatformProblems(m)
  if (platformProblems.length > 0) {
    stop(
      1,
      `error: ${m.id} declares platform resources this kit cannot provision:`,
      ...platformProblems.map(p => `  ${p}`),
      '',
      'That is a bug in the plugin. Nothing has been written.'
    )
  }

  // Target collisions. Both halves matter: a directory that is already there, and an id already
  // recorded — the second is how a re-run of `--apply` would otherwise silently reinstall.
  if (host.plugins.some(s => s.id === m.id)) {
    stop(
      7,
      `error: plugin '${m.id}' is already installed — \`pnpm plugin upgrade ${m.id}\` moves it forward`
    )
  }
  const collisions = pluginRoots(m.id).filter(r => existsSync(abs(r)))
  if (collisions.length > 0) {
    stop(7, `error: these directories already exist:`, ...collisions.map(r => `  ${r}`))
  }

  // **The compatibility answer, computed BEFORE a single byte is copied.** `m.uses` is what this
  // plugin names of the host surface — derived from its own imports by its release, never typed by
  // an author — and the ledger is what this kit provides. The difference is a set difference over
  // strings: it cannot throw, and whatever is missing names itself and carries its replacement.
  const problems = checkRequirements({
    requires: m.requires,
    minKit: floorOf(m),
    uses: m.uses,
    ledger: requireLedger(),
    kitVersion: host.kitVersion,
    presentSurfaces: host.presentSurfaces,
    installedPlugins: host.plugins.map(p => ({ id: p.id, version: p.source?.version ?? null })),
    vendored,
  })

  // A dependency this plugin wants at a range the host — or another installed plugin — already
  // pins differently. `pnpm add` would overwrite it without a word, and `package.json` is `manual`
  // in `.rocketflare.json`, so no kit upgrade ever reconciles it. It WARNS rather than refusing (a
  // clash is often the intended change) and is surfaced as a HUMAN step, which is where the
  // taxonomy makes a decision unmissable.
  const clashes = dependencyClashes(m, {
    packageJsons: packageJsonsFor(m),
    installed: installedDependencyDeclarations(host),
  })

  const byRoot = {}
  for (const root of pluginRoots(m.id)) {
    byRoot[root] = files.filter(f => f.role === 'copy' && f.root === root).length
  }
  const local = args.local || host.isKit
  const barrels = BARREL_KINDS.filter(k => files.some(f => f.path === BARRELS[k].half(m.id)))
  const plan = {
    manifest: m,
    source: { repo, subdir, ref: source.ref, commit: source.commit },
    host: {
      label: host.label,
      kitVersion: host.kitVersion,
      recordsIn: local ? path.basename(host.sidecarPath) : path.basename(host.manifestPath),
      translated: Boolean(host.names),
    },
    vendored,
    problems,
    clashes,
    files,
    byRoot,
    barrels,
    verify: verifyText(source, m.version),
  }
  if (args.json) out(JSON.stringify(addPlanJson(plan), null, 2))
  else out(...renderAddPlan(plan))

  if (problems.length > 0) {
    warn('', `error: ${problems.length} requirement(s) unmet — nothing written.`)
    return 6
  }
  if (!args.apply) {
    if (!args.json) out('', 'Nothing written. Read the plan, then re-run with --apply to install.')
    return 0
  }

  // --- apply
  let written = 0
  const targets = []
  for (const f of files) {
    if (f.role !== 'copy' && f.role !== 'note') continue
    writeInto(f.target, materialise(source.read(f.path), host.names))
    targets.push(f.target)
    written += 1
  }
  // **The anchor is a COPY, not a second thing an author keeps in step.** It used to be a file the
  // plugin shipped alongside its release manifest, and the two drifted the moment a release stamped
  // one and not the other: every install of `analytics` 2.0.1 then failed the audit with "plugin.json
  // says X and the surface says Y", over code that was perfectly correct. Writing it from the source
  // manifest here makes that state unrepresentable.
  const anchorPath = m.anchor ?? `apps/web/src/plugins/${m.id}/plugin.json`
  writeInto(anchorPath, materialise(source.read(PLUGIN_MANIFEST_FILE), host.names))
  if (!targets.includes(anchorPath)) targets.push(anchorPath)
  for (const kind of barrels) {
    const file = abs(BARRELS[kind].file)
    writeFileSync(file, addBarrelLine(readFileSync(file, 'utf8'), kind, m.id))
  }
  // Core files the plugin declared but may not edit itself. The host writes them, exactly as
  // `provision cloudflare` writes a declared binding — printing them as a "by hand" step left
  // `pnpm build` broken for anyone who did not read the plan, `plugin-ci.yml` included.
  const coreEdits = coreEditsByFile(m)
  for (const [file, edits] of coreEdits) {
    writeFileSync(abs(file), applyCoreEdits(readFileSync(abs(file), 'utf8'), edits))
  }
  // Said again at the moment it happens, not only in the plan: `pnpm add` is about to overwrite
  // the range, and stderr is what a log keeps.
  for (const c of clashes) warn(`warning: ${describeClash(c)}`)
  installDependencies(m, 'add')
  const formatted = formatWritten([
    ...targets,
    ...barrels.map(k => BARRELS[k].file),
    ...coreEdits.keys(),
  ])
  const recordedIn = recordSurface(
    host,
    buildPluginSurface(m, {
      repo,
      subdir,
      commit: source.commit,
      at: new Date().toISOString().slice(0, 10),
    }),
    { local }
  )
  out(
    '',
    `✔ ${written} file(s) copied${host.names ? ' and translated' : ''}`,
    `✔ ${barrels.length} barrel line(s) written`,
    ...(coreEdits.size > 0
      ? [`✔ core edit(s) applied to ${[...coreEdits.keys()].join(', ')}`]
      : []),
    ...(formatted ? [`✔ ${formatted}`] : []),
    `✔ surface '${m.id}' recorded in ${path.relative(REPO_ROOT, recordedIn)}`,
    '',
    'Now work the steps above — the schema migration first; nothing else can run until the tables',
    'exist. Each AGENT step names the assertion that proves it; each HUMAN step is a decision.'
  )
  return 0
}

/**
 * Biome over what was just written, and this is not tidiness.
 *
 * A plugin is authored in the KIT's vocabulary and translated on the way in, so its import
 * specifiers change length AND sort order: `@heroicons/react` sorts BEFORE `@rocketflare/shared`
 * and AFTER `@acme/shared`. The kit's own file is correctly sorted; the same file translated into
 * an app whose scope sorts the other way is not, and `pnpm lint` — the first line of the gate the
 * plan tells you to run next — fails on a file the tool wrote. `rename.mjs` solves the identical
 * problem the identical way (it runs `pnpm lint:fix` at the end of its pass).
 *
 * Best-effort, like the rename's: a host without biome, or a rule biome cannot fix, is a warning
 * and not a failed install. Scoped to the paths this install touched, so it never reformats
 * somebody's unrelated work in progress.
 */
function formatWritten(paths) {
  const r = spawnSync('pnpm', ['exec', 'biome', 'check', '--write', ...paths], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.error || r.status === null) {
    warn('note: biome did not run — check the formatting of the copied files with `pnpm lint`.')
    return null
  }
  if (r.status !== 0) {
    warn('note: biome reported problems it could not fix — `pnpm lint` will show them.')
  }
  return 'formatted with biome (translation changes import order)'
}

/**
 * Dependencies are the HOST's: a plugin declares them, the host installs them into its own
 * packages. `remove` deliberately only PRINTS the inverse — `pnpm remove` on a package something
 * else has meanwhile started importing is a broken build that re-running the command cannot undo.
 */
function installDependencies(m, verb) {
  for (const [pkg, deps] of Object.entries(m.dependencies ?? {})) {
    const specs = Object.entries(deps ?? {}).map(([n, v]) => (verb === 'add' ? `${n}@${v}` : n))
    if (specs.length === 0) continue
    if (verb !== 'add') {
      out(`  pnpm --dir ${pkg} remove ${specs.join(' ')}`)
      continue
    }
    out(`  pnpm --dir ${pkg} add ${specs.join(' ')}`)
    const r = spawnSync('pnpm', ['--dir', pkg, 'add', ...specs], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    if (r.status !== 0)
      stop(1, `error: \`pnpm --dir ${pkg} add\` failed — install it yourself, then re-run`)
  }
}

// ---------------------------------------------------------------- upgrade

/** Identity of one declared core edit, for "does the new release still want this one?". */
const coreEditKey = edit => `${edit.file} ${edit.after} ${(edit.lines ?? []).join('\n')}`

/** The frontmatter fields a PLUGIN note may carry beyond the kit's own. */
const PLUGIN_NOTE_FIELDS = [
  'requires_kit',
  'requires_plugins',
  'migrations',
  'data_migrations',
  'touches_registries',
]

function cmdUpgrade(args, host) {
  const id = args.positional[0]
  if (!id) stop(2, 'error: upgrade needs a plugin id', '', USAGE)
  const surface = findSurface(host, id)
  const source = surface.source ?? {}

  // A vendored plugin ships INSIDE the kit, so its history is the kit's history and porting it
  // separately would apply the same bytes twice, from two chains that cannot both be right.
  if (isVendored(source, host.kitRepo)) {
    out(
      `${id} is vendored — it ships inside ${host.kitRepo} with no subdirectory, so the kit release`,
      'that moves it forward is the one that moves it. Upgrade it with `pnpm kit:upgrade`.'
    )
    return 0
  }
  if (args.apply) requireClean(host, args)

  const m = ensureMirror(source.repo, pluginMirrorDir(source.repo), {
    fetch: args.fetch,
    cwd: REPO_ROOT,
    warn,
  })
  const subdir = (source.subdir ?? '').replace(/^\/|\/$/g, '')
  const relative = subdir === '' ? null : subdir
  const from = args.from ?? source.commit
  if (!from) {
    stop(
      1,
      `error: ${id}'s surface records no source commit, so there is no baseline to diff from.`,
      'Pass --from <ref> with the release it was installed at (its CHANGELOG is the best guess).'
    )
  }
  if (!m.resolves(from)) stop(1, `error: '${from}' is not in ${source.repo}`)
  const to = args.to ?? m.latestTag() ?? 'HEAD'
  if (!m.resolves(to)) stop(1, `error: '${to}' is not in ${source.repo}`)
  if (m.commitOf(from) === m.commitOf(to)) {
    out(`${id} is already at ${to} — nothing to do.`)
    return 0
  }
  const toVersion = /^\d+\.\d+\.\d+$/.test(to) ? to : null

  const notes = notesBetween(m, to, {
    after: source.version ?? null,
    through: toVersion,
    dir: subdir === '' ? 'docs/upgrades' : `${subdir}/docs/upgrades`,
  })

  const changes = collectChanges(m, from, to, { relative })
  const files = changes.map(c => ({ ...c, ...classifyPluginFile(c.path, id) }))
  const refused = files.filter(f => f.role === 'refused')
  if (refused.length > 0) {
    stop(
      1,
      `error: ${refused.length} changed file(s) fall outside ${id}'s roots:`,
      ...refused.map(f => `  ${f.path}`)
    )
  }

  // The plugin's OWN manifest, at the version being installed — read BEFORE anything is applied,
  // because the anchor `plugin.json` in the tree is one of the files the patch overwrites.
  //
  // It is what `requires` and `coreEdits` must come from. The surface records what the plugin said
  // on the day it was first installed, and leaving either frozen there is how a plugin that raised
  // its floor, or that started needing a line in a core file, arrives silently broken.
  const pluginManifestPath =
    subdir === '' ? PLUGIN_MANIFEST_FILE : `${subdir}/${PLUGIN_MANIFEST_FILE}`
  const shownManifest = m.tryShow(to, pluginManifestPath)
  let targetManifest = null
  if (shownManifest.ok) {
    try {
      targetManifest = JSON.parse(shownManifest.out)
    } catch {
      stop(1, `error: ${pluginManifestPath} at ${to} is not valid JSON — a bug in the plugin.`)
    }
  }
  const installedManifest = existsSync(abs(surface.anchor))
    ? JSON.parse(readFileSync(abs(surface.anchor), 'utf8'))
    : {}

  // Every note's `requires_kit` is checked against THIS kit, because a plugin release may raise
  // its floor and the whole point of the range is that nobody finds out at the gate.
  const local = new Set(host.tracked)
  const workRoot = abs(path.join(WORK_DIR, 'work', id, toVersion ?? to.slice(0, 12)))
  const artifacts = makeWriter(workRoot)
  artifacts.reset()

  const patches = []
  const added = []
  const warnings = []
  for (const f of files) {
    if (f.role === 'note') {
      if (f.change !== 'deleted')
        artifacts.write(
          path.join('notes', path.basename(f.path)),
          m.show(to, subdir === '' ? f.path : `${subdir}/${f.path}`)
        )
      continue
    }
    if (f.role === 'fragment' || f.role === 'meta') {
      if (f.change !== 'deleted') {
        artifacts.write(
          path.join('reference', f.path),
          m.show(to, subdir === '' ? f.path : `${subdir}/${f.path}`)
        )
      }
      continue
    }
    if (f.role === 'repo-only' || f.change === 'deleted' || f.change === 'binary') continue
    if (f.change === 'added' || !local.has(f.target)) {
      const body = materialise(
        m.showRaw(to, subdir === '' ? f.path : `${subdir}/${f.path}`),
        host.names
      )
      artifacts.write(path.join('added', f.target), body)
      added.push(f.target)
      continue
    }
    const raw = m.run([
      'diff',
      '--no-renames',
      ...(relative ? [`--relative=${relative}`] : []),
      from,
      to,
      '--',
      subdir === '' ? f.path : `${subdir}/${f.path}`,
    ])
    const blocks = splitDiff(raw)
    if (blocks.length === 0) continue
    try {
      const translated = blocks
        .map(b => {
          const t = translateBlock(b, host.names ?? deriveNames('rocketflare', 'Rocketflare'), {
            translate: Boolean(host.names),
          })
          if (countLines(stripIndexLines(b.raw)) !== countLines(t)) {
            throw new Error(`translation changed the line count of ${f.path}`)
          }
          return t
        })
        .join('')
      artifacts.write(path.join('files', `${f.target}.patch`), translated)
      patches.push({ path: f.target, text: translated })
    } catch (err) {
      warnings.push(`${f.path}: ${err.message}`)
    }
  }
  artifacts.write('apply.patch', patches.map(p => p.text).join(''))

  const noteFacts = notes.map(n => {
    const data = parseNote(n.text)?.data ?? {}
    return {
      version: n.version,
      ...Object.fromEntries(PLUGIN_NOTE_FIELDS.map(k => [k, data[k] ?? null])),
    }
  })
  artifacts.write(
    'plan.json',
    `${JSON.stringify({ id, from: m.commitOf(from), to: { ref: to, commit: m.commitOf(to), version: toVersion }, files, notes: noteFacts, warnings }, null, 2)}\n`
  )

  out(
    `${id}  ${source.version ?? '?'} → ${toVersion ?? to}`,
    `  source    ${source.repo}${subdir ? `#${subdir}` : ''}`,
    `  files     ${files.length} changed: ${added.length} added, ${patches.length} patched` +
      `, ${files.filter(f => f.change === 'deleted').length} deleted in the plugin (left in place)`,
    `  artifacts ${path.relative(REPO_ROOT, workRoot)}`
  )
  if (notes.length > 0) {
    out('', 'Release notes:')
    for (const n of noteFacts) {
      out(`  ${n.version}`)
      for (const key of PLUGIN_NOTE_FIELDS) {
        const v = n[key]
        if (v && (!Array.isArray(v) || v.length > 0))
          out(`    ${key}: ${Array.isArray(v) ? v.join('; ') : v}`)
      }
    }
  }
  // Two sources for one question: a release may raise its floor in a NOTE, or simply by changing
  // the manifest — and the manifest's is the one that ends up recorded on the surface, so checking
  // only the notes would let an upgrade stamp a range this kit does not satisfy.
  const below = floor =>
    Boolean(floor) && (!BARE_VERSION.test(floor) || compareVersions(host.kitVersion, floor) < 0)
  const floors = noteFacts.filter(n => below(n.requires_kit))
  const declaredFloor = floorOf(targetManifest)
  const manifestFloor = below(declaredFloor) ? declaredFloor : null
  if (floors.length > 0 || manifestFloor) {
    warn(
      '',
      `error: this kit is ${host.kitVersion}, and ${id} needs more:`,
      ...floors.map(n => `  ${n.version} needs kit ${n.requires_kit} or newer`),
      ...(manifestFloor ? [`  ${toVersion ?? to} declares minKit ${manifestFloor}`] : []),
      '',
      'Upgrade the kit first (`pnpm kit:upgrade`), then come back to this.'
    )
    return 6
  }
  const touched = [...new Set(noteFacts.flatMap(n => n.touches_registries ?? []))]
  if (touched.length > 0) {
    out(
      '',
      `touches_registries: ${touched.join(', ')} — re-check those barrel lines after applying.`
    )
  }
  for (const w of warnings) out(`  warning: ${w}`)

  if (!args.apply) {
    out('', 'Nothing written to your tree. Re-run with --apply.')
    return 0
  }

  for (const rel of added) writeInto(rel, readFileSync(path.join(workRoot, 'added', rel)))
  let rejected = 0
  if (patches.length > 0) {
    const combined = path.join(workRoot, 'apply.patch')
    const check = gitQuiet([
      '-c',
      'core.autocrlf=false',
      'apply',
      '--check',
      '--whitespace=nowarn',
      '-p1',
      combined,
    ])
    if (check.ok) {
      git(['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-p1', combined])
    } else {
      for (const p of patches) {
        const one = path.join(workRoot, 'files', `${p.path}.patch`)
        const r = gitQuiet([
          '-c',
          'core.autocrlf=false',
          'apply',
          '--reject',
          '--whitespace=nowarn',
          '-p1',
          one,
        ])
        if (!r.ok) rejected += 1
      }
    }
  }
  // The plugin's own notes are kept beside it, in the host's vocabulary-free corner: they describe
  // the PLUGIN's releases, which is what the next upgrade's `from` is read against.
  for (const n of notes) writeInto(`docs/plugins/${id}/upgrades/${path.basename(n.file)}`, n.text)

  // Core files the plugin declared but may not edit itself — the same rule `add` follows, and an
  // UPGRADE has to follow it too: a release that starts needing an alias in `vite.config.ts` would
  // otherwise apply cleanly and fail at `pnpm build`, which is precisely the failure declared edits
  // were introduced to remove. Idempotent, so a line already present is not written twice.
  const coreEditWarnings = []
  const coreEditFiles = []
  if (targetManifest) {
    const wanted = coreEditsByFile(targetManifest)
    // An edit the new release no longer declares is REVERTED, or the host keeps a line pointing at
    // something the plugin has stopped shipping.
    for (const [file, edits] of coreEditsByFile(installedManifest)) {
      const keep = wanted.get(file) ?? []
      const dropped = edits.filter(e => !keep.some(k => coreEditKey(k) === coreEditKey(e)))
      if (dropped.length === 0 || !existsSync(abs(file))) continue
      writeFileSync(abs(file), revertCoreEdits(readFileSync(abs(file), 'utf8'), dropped))
      coreEditFiles.push(file)
    }
    for (const [file, edits] of wanted) {
      if (!existsSync(abs(file))) {
        coreEditWarnings.push(`core edit for ${file}: no such file here — apply it by hand`)
        continue
      }
      try {
        writeFileSync(abs(file), applyCoreEdits(readFileSync(abs(file), 'utf8'), edits))
        if (!coreEditFiles.includes(file)) coreEditFiles.push(file)
      } catch (err) {
        // A moved anchor must not abort an upgrade whose files are already on disk: report it and
        // let the person place the line, exactly as they would from the plan.
        coreEditWarnings.push(err instanceof Error ? err.message : String(err))
      }
    }
  }

  out(
    '',
    `✔ ${added.length} added, ${patches.length - rejected} patched` +
      (rejected > 0 ? `, ${rejected} with rejects (*.rej beside the file)` : ''),
    ...(coreEditFiles.length > 0 ? [`✔ core edit(s) applied to ${coreEditFiles.join(', ')}`] : []),
    ...coreEditWarnings.map(w => `  warning: ${w}`)
  )
  if (rejected === 0) {
    const raw = JSON.parse(
      readFileSync(host.sidecarIds.includes(id) ? host.sidecarPath : host.manifestPath, 'utf8')
    )
    const entry = raw.surfaces.find(s => s.id === id)
    entry.history = [
      ...(entry.history ?? []),
      {
        from: source.commit ?? from,
        to: m.commitOf(to),
        at: new Date().toISOString().slice(0, 10),
      },
    ]
    entry.source = {
      ...entry.source,
      version: toVersion ?? entry.source.version,
      commit: m.commitOf(to),
    }
    // `requires` is REFRESHED from the manifest at the version just installed, never left at what
    // the plugin said on the day it was first installed. Frozen, a plugin that raised its floor or
    // gained a plugin dependency stays recorded as wanting the old one — and `plugin check`,
    // `kit:upgrade` and `kit:release` all read the surface, so all three would keep agreeing with
    // a statement that is no longer true. Nothing ELSE on the entry is rewritten here.
    if (targetManifest) {
      entry.minKit = floorOf(targetManifest)
      entry.requires = {
        surfaces: targetManifest.requires?.surfaces ?? [],
        plugins: targetManifest.requires?.plugins ?? [],
      }
    }
    writeManifestFile(host.sidecarIds.includes(id) ? host.sidecarPath : host.manifestPath, raw, {
      format: !host.sidecarIds.includes(id),
    })
    out(`✔ surface '${id}' stamped at ${toVersion ?? m.commitOf(to).slice(0, 12)}`)
  } else {
    out('The surface is NOT stamped while rejects remain — resolve them and re-run.')
  }
  const migrations = noteFacts.flatMap(n => n.migrations ?? [])
  if (migrations.length > 0) {
    out(
      '',
      'This upgrade changes the schema. The HOST generates the migration:',
      `  pnpm db:generate --name plugin-${id}-${toVersion ?? 'upgrade'}`,
      ...migrations.map(x => `    ${x}`)
    )
  }
  out('', 'Verify: pnpm lint && pnpm typecheck && pnpm test && pnpm build')
  return rejected > 0 ? 4 : 0
}

// ---------------------------------------------------------------- remove

function cmdRemove(args, host) {
  const id = args.positional[0]
  if (!id) stop(2, 'error: remove needs a plugin id', '', USAGE)
  const surface = findSurface(host, id)
  if (args.apply) requireClean(host, args)

  // A plugin another plugin depends on is not removable, and the check is not advisory: the
  // dependent's code imports the four published entries of this one, so removing it is a build
  // failure with no obvious cause.
  const dependents = host.plugins.filter(
    p => p.id !== id && (p.requires?.plugins ?? []).some(r => parsePluginRequirement(r).id === id)
  )
  if (dependents.length > 0) {
    warn(
      `error: ${dependents.map(d => `'${d.id}'`).join(', ')} ${dependents.length === 1 ? 'requires' : 'require'} '${id}'.`,
      'Remove them first, or drop the requirement from their manifests.'
    )
    return 6
  }

  const directories = surfaceDirectories(surface).filter(d => existsSync(abs(d)))
  const barrels = BARREL_KINDS.filter(k =>
    hasBarrelLine(readFileSync(abs(BARRELS[k].file), 'utf8'), k, id)
  )
  const anchorManifest = existsSync(abs(surface.anchor))
    ? JSON.parse(readFileSync(abs(surface.anchor), 'utf8'))
    : {}
  const tables = anchorManifest.schema?.tables ?? []

  const say = (...lines) => {
    if (!args.json) out(...lines)
  }
  say(
    `Remove ${id}@${surface.source?.version ?? '?'} from ${host.label}`,
    '',
    'Deletes',
    ...directories.map(d => `  ${d}`),
    ...(directories.length === 0 ? ['  (no directories — already gone)'] : []),
    '',
    'Barrel lines removed',
    ...barrels.map(k => `  ${BARRELS[k].file}  —  ${barrelLines(k, id).join('  +  ')}`),
    ...(barrels.length === 0 ? ['  (none)'] : []),
    '',
    `Surface '${id}' dropped from ${path.basename(host.sidecarIds.includes(id) ? host.sidecarPath : host.manifestPath)}`
  )
  // What is LEFT, classified. Most of it is `human`, and that is the honest answer rather than a
  // gap: a migration full of `DROP TABLE`, an `--archive` copy taken or knowingly skipped, a
  // `deleted_classes` migration that deletes a Durable Object namespace and everything in it, and
  // live Cloudflare resources that may still hold somebody's data. Provisioning creates a plugin's
  // resources (decision 12) and deliberately never deletes one.
  const steps = removeSteps(anchorManifest, {
    archive: args.archive,
    // Read from the toml rather than assumed: the tag is append-only, so the next one is the next
    // free number after every `plugin-<id>-v<n>` this Worker has already told Cloudflare about.
    migrationTag: nextPluginMigrationTag(tomlMigrationTags(), id),
  })
  if (args.json) {
    out(
      JSON.stringify(
        {
          plugin: { id, version: surface.source?.version ?? null },
          deletes: { directories, barrels: barrels.map(k => BARRELS[k].file), tables },
          steps,
        },
        null,
        2
      )
    )
  } else {
    out(...renderSteps(steps, 'Steps — nothing below is done for you'))
  }

  if (!args.apply) {
    say('', 'Nothing written. Re-run with --apply to remove it.')
    return 0
  }

  if (args.archive && tables.length > 0) writeArchiveMigration(id, tables)
  for (const d of directories) rmSync(abs(d), { recursive: true, force: true })
  for (const kind of barrels) {
    const file = abs(BARRELS[kind].file)
    writeFileSync(file, removeBarrelLine(readFileSync(file, 'utf8'), kind, id))
  }
  // The exact inverse of what `add` wrote, so uninstalling does not strand an alias pointing at
  // a directory that has just been deleted.
  const removedEdits = coreEditsByFile(anchorManifest)
  for (const [file, edits] of removedEdits) {
    if (!existsSync(abs(file))) continue
    writeFileSync(abs(file), revertCoreEdits(readFileSync(abs(file), 'utf8'), edits))
  }
  const dropped = dropSurface(host, id)
  say(
    '',
    `✔ ${directories.length} director(ies) deleted`,
    `✔ ${barrels.length} barrel line(s) removed`,
    ...(removedEdits.size > 0
      ? [`✔ core edit(s) reverted in ${[...removedEdits.keys()].join(', ')}`]
      : []),
    `✔ surface dropped from ${dropped.map(f => path.basename(f)).join(', ') || '(nowhere — it was not recorded)'}`,
    ...renderSteps(steps, 'Steps that remain')
  )
  return 0
}

/**
 * `pnpm db:generate --custom` then fill the file it made.
 *
 * The journal is what names the file, and drizzle-kit chooses that name — so the new entry is
 * found by diffing the journal around the call rather than by predicting it.
 */
function writeArchiveMigration(id, tables) {
  const journalPath = abs('apps/web/migrations/meta/_journal.json')
  const before = new Set(JSON.parse(readFileSync(journalPath, 'utf8')).entries.map(e => e.tag))
  const r = spawnSync(
    'pnpm',
    ['--dir', 'apps/web', 'db:generate', '--custom', '--name', `plugin-${id}-archive`],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    }
  )
  if (r.status !== 0)
    stop(1, 'error: `pnpm db:generate --custom` failed — nothing has been deleted')
  const tag = JSON.parse(readFileSync(journalPath, 'utf8'))
    .entries.map(e => e.tag)
    .find(t => !before.has(t))
  if (!tag) stop(1, 'error: db:generate wrote no new journal entry — nothing has been deleted')
  const file = `apps/web/migrations/${tag}.sql`
  writeFileSync(abs(file), archiveSql(id, tables))
  out(
    `✔ ${file} carries the archive copy of ${tables.join(', ')} — run pnpm db:migrate BEFORE the drop`
  )
}

/**
 * Every `[[migrations]]` tag already in the production toml. Read textually rather than parsed: the
 * tomls are patched at the string level everywhere else for the same reason (`patch-toml.ts`), and
 * this script has no TOML dependency.
 */
function tomlMigrationTags() {
  const file = abs('apps/web/wrangler.toml')
  if (!existsSync(file)) return []
  return [...readFileSync(file, 'utf8').matchAll(/^tag\s*=\s*"([^"]+)"/gm)].map(m => m[1])
}

// ---------------------------------------------------------------- list / check

function cmdList(_args, host) {
  out(...renderList(host.plugins, { sidecarIds: host.sidecarIds }))
  return 0
}

/**
 * Audit every installed plugin. One line per failure and exit 1 on any — this is the thing
 * `/rf-preflight` and CI run, so it says what is wrong rather than how to fix it.
 */
function cmdCheck(args, host) {
  const findings = []
  const ledger = requireLedger()
  /**
   * One finding, carrying the EDIT rather than only the complaint.
   *
   * `fail` changes the exit code; `warn` reports and does not. **There is no longer a tier a
   * plugin opts into**: the two PREDICTED numbers that used to decide it — a kit range and a
   * contract version — are gone, and nothing left here is a rule a released plugin cannot
   * retroactively satisfy. Every plugin is checked strictly; `warn` is kept for the findings that
   * are not faults in the plugin at all.
   */
  const add = (severity, key, d) =>
    findings.push({
      id: key,
      severity,
      kind: 'agent',
      assert: 'pnpm plugin check',
      file: d.file,
      line: d.line ?? null,
      problem: d.problem,
      fix: d.fix,
      message: renderDiagnostic(d),
    })
  // Things worth SAYING that are not faults — a state the kit itself is legitimately in, or a
  // silence somebody should know about. Printed either way; they never change the exit code.
  const notes = []
  // Every plugin's parsed manifest, kept for the checks that are about the COMBINATION rather than
  // about one plugin: two plugins cannot share a table name, and neither of them is wrong alone.
  const anchors = []
  for (const s of host.plugins) {
    const id = s.id
    const vendored = isVendored(s.source, host.kitRepo)
    if (!existsSync(abs(s.anchor))) {
      add('fail', `${id}:anchor`, {
        file: s.anchor,
        problem: `is missing, and the surface says '${id}' is installed`,
        fix:
          `reinstall it with \`pnpm plugin add ${s.source?.repo ?? '<repo>'} --apply\`, or drop ` +
          `the '${id}' surface from ${path.basename(host.manifestPath)}`,
      })
      continue
    }
    // Two plugins are not held to a kit range, for the same reason in two shapes.
    //
    // A VENDORED plugin is version-locked to the kit it ships inside, so its range describes that
    // kit rather than a claim about compatibility. Checking it makes the kit fail against itself
    // for the whole of the release in which the range is raised.
    //
    // A plugin being AUTHORED — recorded in the sidecar, inside the kit itself — is in exactly the
    // same position: the working tree it is written against is the release that has not been cut
    // yet, so its floor is always one bump ahead of `package.json` until `pnpm kit:release` runs.
    // That is the authoring loop working, not a fault, and failing it here would mean the gate
    // could never be green on the branch that raises the floor. In an APP (where `isKit` is false)
    // a `--local` plugin is still checked: there the range is a real claim about somebody's kit.
    // Narrower than it looks: the range is still CHECKED, and a plugin whose range this kit
    // already satisfies passes on its own merits. What is skipped is the failure an uncut release
    // guarantees — and only in the kit, for a plugin recorded in the sidecar, which is exactly the
    // authoring loop.
    // Read ONCE, and before anything that reports against it: every diagnostic below wants a line
    // number in this file, and a manifest that will not parse has to be a finding rather than a
    // stack trace out of `cmdCheck` that says nothing about which plugin it came from.
    const anchorSource = readFileSync(abs(s.anchor), 'utf8')
    let anchor
    try {
      anchor = JSON.parse(anchorSource)
    } catch (err) {
      add('fail', `${id}:manifest-json`, {
        file: s.anchor,
        problem: `is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        fix: 'fix the syntax — every other check on this plugin reads this file',
      })
      continue
    }
    anchors.push({ surface: s, source: anchorSource, manifest: anchor })

    // Every field, naming the field and its legal values.
    for (const p of pluginManifestProblems(anchor)) {
      add('fail', `${id}:manifest:${p.field || 'root'}`, {
        file: s.anchor,
        line: p.field ? jsonKeyLine(anchorSource, p.field) : null,
        problem: p.problem,
        fix: p.fix,
      })
    }

    const authoredHere = host.isKit && host.sidecarIds.includes(id)
    for (const problem of checkRequirements({
      requires: s.requires,
      // A plugin AUTHORED here names the floor of a release that has not been cut yet, so it is
      // always one bump ahead of `package.json` until `pnpm kit:release` runs. That is the
      // authoring loop working, not a fault — and only in the kit, for a sidecar plugin.
      minKit: authoredHere ? null : floorOf(s),
      kitVersion: host.kitVersion,
      presentSurfaces: host.presentSurfaces,
      installedPlugins: host.plugins.map(p => ({ id: p.id, version: p.source?.version ?? null })),
      vendored,
    })) {
      add('fail', `${id}:requires`, {
        file: s.anchor,
        line: jsonKeyLine(anchorSource, 'requires'),
        problem,
        fix: `satisfy it, or amend "requires" in ${s.anchor} to describe what this plugin needs`,
      })
    }
    // A plugin that declares no floor is beyond every gate there is — `checkRequirements` skips
    // it, `unsupportedForKit` skips it, and `kit:upgrade` would carry it across a major version
    // without a word. That is the plugin's choice to make, but not silently.
    if (!vendored && floorOf(s) === null) {
      notes.push(`${id}: declares no minKit, so no kit version is ever checked against it`)
    }

    // **Compatibility, OBSERVED.** Every symbol the plugin names of the host surface, against what
    // this kit's ledger actually provides. This is the check the two predicted numbers were
    // standing in for, and unlike them it cannot be stale: `uses` is derived from the plugin's own
    // imports and the ledger is generated from the kit's own source.
    for (const gone of missingFrom(anchor.uses, ledger)) {
      add('fail', `${id}:surface:${gone.entry}:${gone.symbol}`, {
        file: s.anchor,
        line: jsonKeyLine(anchorSource, 'uses'),
        problem: `uses ${gone.symbol} from ${gone.entry}, which this kit no longer provides`,
        fix:
          gone.suggestion ??
          `${gone.symbol} is gone from the kit's surface — see docs/plugin-api.md for what replaces it, then release the plugin`,
      })
    }
    for (const kind of BARREL_KINDS) {
      const half = BARRELS[kind].half(id)
      const ships = existsSync(abs(half))
      const wired = hasBarrelLine(readFileSync(abs(BARRELS[kind].file), 'utf8'), kind, id)
      if (ships && !wired) {
        add('fail', `${id}:barrel:${kind}`, {
          file: BARRELS[kind].file,
          problem: `has no line for '${id}', and ${half} is on disk`,
          fix: `add:  ${barrelLines(kind, id).join('  +  ')}`,
        })
      }
      if (!ships && wired) {
        add('fail', `${id}:barrel:${kind}`, {
          file: BARRELS[kind].file,
          problem: `names '${id}', and ${half} is not on disk`,
          fix: `remove:  ${barrelLines(kind, id).join('  +  ')}`,
        })
      }
    }
    const rejects = surfaceDirectories(s)
      .filter(d => existsSync(abs(d)))
      .flatMap(d => walk(abs(d)).map(f => `${d}/${f}`))
      .filter(f => f.endsWith('.rej'))
    for (const f of rejects) {
      add('fail', `${id}:reject`, {
        file: f,
        problem: 'is a rejected hunk an upgrade left behind',
        fix: `apply it into ${f.replace(/\.rej$/, '')} by reading both, then delete ${f}`,
      })
    }

    // A DO or Workflow class reaches the Worker through the sixth barrel and nowhere else, so
    // `workerExports` is checkable rather than advisory — and it is checked BOTH ways. A name in
    // the manifest that the file does not export is a binding pointed at nothing, and
    // `wrangler deploy` refuses the whole script for it; a class the file exports that the
    // manifest does not name is invisible to `pnpm provision cloudflare <env>`, which reads that
    // list to write the `[[durable_objects.bindings]]` / `[[workflows]]` block — so it deploys
    // with no binding at all.
    const declaredExports = anchor.workerExports ?? []
    const workerHalf = BARRELS.worker.half(id)
    const shipsWorkerHalf = existsSync(abs(workerHalf))
    if (declaredExports.length > 0 && !shipsWorkerHalf) {
      add('fail', `${id}:worker-half`, {
        file: workerHalf,
        problem: `is missing, and ${s.anchor} declares workerExports (${declaredExports.join(', ')})`,
        fix:
          `create it, re-exporting ${declaredExports.join(', ')} — Cloudflare resolves a binding's ` +
          'class_name against the named exports of src/worker.ts, which this barrel half feeds',
      })
    }
    if (shipsWorkerHalf) {
      // `opaque` is an `export *`, whose names need the module resolved to enumerate. Both
      // directions are skipped for one rather than guessed: reporting "declares OrdersHub and does
      // not export it" against a star re-export that plainly does teaches an author to distrust
      // the whole audit.
      const { names, opaque } = workerExportNames(readFileSync(abs(workerHalf), 'utf8'))
      if (declaredExports.length === 0) {
        add('fail', `${id}:worker-undeclared`, {
          file: s.anchor,
          line: jsonKeyLine(anchorSource, 'workerExports'),
          problem: `declares no workerExports, and ${workerHalf} is on disk`,
          fix:
            `set "workerExports" to [${names.map(n => `"${n}"`).join(', ')}] — provisioning reads ` +
            'that list to write the binding block, so a class missing from it gets no binding',
        })
      }
      if (!opaque) {
        for (const name of declaredExports.filter(n => !names.includes(n))) {
          add('fail', `${id}:worker-missing:${name}`, {
            file: workerHalf,
            problem: `does not export ${name}, which ${s.anchor} declares in workerExports`,
            fix:
              `add \`export { ${name} } from './<module>'\` here, or drop "${name}" from ` +
              'workerExports — wrangler deploy refuses the script for a class_name nothing exports',
          })
        }
        for (const name of names.filter(n => !declaredExports.includes(n))) {
          add('fail', `${id}:worker-extra:${name}`, {
            file: s.anchor,
            line: jsonKeyLine(anchorSource, 'workerExports'),
            problem: `does not declare ${name}, which ${workerHalf} exports`,
            fix:
              `add "${name}" to "workerExports" — a class the manifest does not name is invisible ` +
              'to `pnpm provision cloudflare <env>`, which writes its binding block',
          })
        }
      }
    }

    // **A Durable Object is state the FK cascade cannot reach.** Deleting a tenant is one SQL
    // DELETE plus the `tenant.purge` job (D7), and that job is the ONLY thing that ever visits a
    // deleted tenant's state outside Postgres — through each plugin's `onTenantDeleted`. A plugin
    // that keeps a DO and declares no hook leaves one organisation's data live for ever, silently,
    // and no other check can see it: its TABLES are gone, so everything else reads as clean.
    const doBindings = (anchor.bindings ?? []).filter(b => b?.type === 'durable_object')
    if (doBindings.length > 0) {
      const tree = `apps/web/src/plugins/${id}`
      const declaresHook =
        existsSync(abs(tree)) &&
        walk(abs(tree)).some(
          f =>
            /\.tsx?$/.test(f) &&
            declaresProperty(readFileSync(abs(`${tree}/${f}`), 'utf8'), 'onTenantDeleted')
        )
      if (!declaresHook) {
        const which = doBindings.map(b => b.binding ?? b.className ?? '?').join(', ')
        add('fail', `${id}:on-tenant-deleted`, {
          file: `${tree}/index.ts`,
          problem: `declares the durable_object binding(s) ${which} and no hooks.onTenantDeleted`,
          fix:
            'add `hooks: { onTenantDeleted: async (db, tenantId, env) => { … } }` to the ' +
            "ServerPlugin and delete this plugin's Durable Object state there. Derive every " +
            'instance name from the tenant id and loop the names you DECLARE — nothing enumerates ' +
            'the instances of a namespace, so only derived keys are reachable',
        })
      }
    }

    // Two separate things a plugin with tables owes, and neither is visible from the other side.
    const tables = (anchor.schema?.tables ?? []).filter(
      t => !(anchor.schema?.rlsExcluded ?? []).includes(t)
    )
    if ((anchor.schema?.tables ?? []).length > 0) {
      const tags = JSON.parse(
        readFileSync(abs('apps/web/migrations/meta/_journal.json'), 'utf8')
      ).entries.map(e => e.tag)
      if (!tags.some(t => t.includes(`plugin-${id}`))) {
        add('fail', `${id}:migration`, {
          file: 'apps/web/migrations/meta/_journal.json',
          problem: `names no migration for '${id}', which declares tables (${anchor.schema.tables.join(', ')})`,
          fix: `pnpm db:generate --name plugin-${id}-${anchor.version ?? '0.0.0'} && pnpm db:migrate`,
        })
      }
    }

    // **Declared dependencies are really installed.** `plugin add --apply` runs `pnpm --dir <pkg>
    // add <name>@<range>` and nothing ever looked again — so an install whose `pnpm add` failed
    // part-way, or a `remove` whose printed `pnpm remove` somebody ran, leaves a plugin whose
    // imports cannot resolve while every other check here reads as perfectly clean.
    for (const d of missingDependencies(anchor, packageJsonsFor(anchor))) {
      if (d.have === null) {
        add('fail', `${id}:dependency:${d.name}`, {
          file: `${d.pkg}/package.json`,
          problem: `does not list ${d.name}, which ${s.anchor} declares at ${d.range}`,
          fix: `pnpm --dir ${d.pkg} add ${d.name}@${d.range}`,
        })
        continue
      }
      // A DIFFERENT range is not the same fault: `package.json` is `manual` in `.rocketflare.json`,
      // so an operator is entitled to have pinned it themselves and no kit upgrade reconciles it.
      add('fail', `${id}:dependency-range:${d.name}`, {
        file: `${d.pkg}/package.json`,
        line: jsonKeyLine(readHostPackageJsonSource(d.pkg), d.name),
        problem: `pins ${d.name} at ${d.have}, and ${s.anchor} declares ${d.range}`,
        fix:
          `pnpm --dir ${d.pkg} add ${d.name}@${d.range}, or set "dependencies"."${d.pkg}"."${d.name}" ` +
          `in ${s.anchor} to ${d.have} — whichever range both can live with`,
      })
    }

    // **The tenant-isolation test the kit cannot write for you.** A plugin's tables are
    // tenant-scoped like every other, and no kit suite can see them — which is why both
    // `docs/CONCEPTS.md` §16 and `.claude/rules/testing.md` say a plugin MUST own this test, and
    // why nothing verified it until now. With agents writing plugins, the one area the kit treats
    // as non-negotiable was the one with no enforcement at all.
    if (tables.length > 0) {
      const testDir = `apps/web/src/plugins/${id}/tests/api`
      const testFiles = existsSync(abs(testDir))
        ? walk(abs(testDir)).filter(f => /\.tsx?$/.test(f))
        : []
      const proven = testFiles.some(
        f => isolationEvidence(readFileSync(abs(`${testDir}/${f}`), 'utf8')).ok
      )
      if (!proven) {
        add('fail', `${id}:isolation`, {
          file: `${testDir}/`,
          problem: `has no test proving another organisation cannot read ${tables.join(', ')}`,
          fix:
            'add a case that creates a SECOND tenant and drives the real mount as it — copy the ' +
            "describe('tenant isolation') block from apps/web/src/plugins/example-feature/tests/" +
            'api/example-feature.test.ts. This proves such a test EXISTS, not that it is correct',
        })
      }
    }
  }
  // **Two plugins declaring one table name.** The prefix convention is what keeps them apart and
  // nothing enforces it, because nothing derives a table name from an id — so the collision is the
  // checkable half, and it is checked here, where every manifest is in hand. Nothing else sees it:
  // TS2308 catches a duplicated EXPORT name, not a duplicated `pgTable('orders')`, and past that
  // point drizzle-kit emits DDL for one name twice and `plugin remove` drops the other's table.
  for (const clash of tableClashes(anchors.map(a => a.manifest))) {
    const entry = anchors.find(a => a.manifest.id === clash.id)
    if (!entry) continue
    const others = clash.others.map(o => `'${o}'`).join(', ')
    add('fail', `${clash.id}:table:${clash.table}`, {
      file: entry.surface.anchor,
      line: jsonKeyLine(entry.source, 'schema.tables'),
      problem: `declares the table ${clash.table}, which ${others} also declares`,
      fix:
        'rename one of them and release that plugin — every table starts with the first ' +
        `hyphen-separated segment of its plugin's id ('${clash.id}' → ` +
        `'${clash.id.split('-')[0]}_*'), and two plugins cannot share a host with one name ` +
        "between them: a single DROP TABLE takes the other plugin's data",
    })
  }
  const failures = findings.filter(f => f.severity === 'fail')
  const warnings = findings.filter(f => f.severity === 'warn')

  // The audit as DATA. Every failure `check` can report is agent-fixable — it is a statement about
  // this tree, not a decision about somebody's data — so each carries `kind: 'agent'` and the one
  // assertion that settles it. A `human` failure would be a contradiction: nothing here waits.
  //
  // `warnings` is the second list rather than a flag on the first, because `ok` has to keep meaning
  // "this exits 0". A rule a released plugin cannot retroactively satisfy belongs in the output and
  // not in the exit code (`auditSeverity`).
  if (args.json) {
    out(
      JSON.stringify(
        {
          ok: failures.length === 0,
          plugins: host.plugins.map(s => ({
            id: s.id,
            version: s.source?.version ?? null,
            vendored: isVendored(s.source, host.kitRepo),
            local: host.sidecarIds.includes(s.id),
            minKit: floorOf(s),
          })),
          failures,
          warnings,
          notes,
        },
        null,
        2
      )
    )
    return failures.length === 0 ? 0 : 1
  }
  for (const n of notes) out(`note: ${n}`)
  for (const w of warnings) out(`warn: ${w.message}`)

  if (host.plugins.length === 0 && failures.length === 0) {
    out('No plugins installed — nothing to check.')
    return 0
  }
  if (failures.length === 0) {
    out(`✔ ${host.plugins.length} plugin(s) check out: ${host.plugins.map(p => p.id).join(', ')}`)
    const vendored = host.plugins.filter(p => isVendored(p.source, host.kitRepo)).map(p => p.id)
    if (vendored.length > 0) {
      out(`  (${vendored.join(', ')} vendored — shipped inside the kit, so minKit is not checked)`)
    }
    // Only the ones whose floor this kit does NOT yet reach are worth a line: an author on the
    // branch that raises the floor sees why they were let through, and an author whose floor is
    // already met sees nothing, because nothing was skipped for them.
    const ahead = host.isKit
      ? host.plugins.filter(p => {
          const floor = floorOf(p)
          return (
            host.sidecarIds.includes(p.id) &&
            floor &&
            (!BARE_VERSION.test(floor) || compareVersions(host.kitVersion, floor) < 0)
          )
        })
      : []
    if (ahead.length > 0) {
      out(
        `  (${ahead.map(p => `${p.id} wants kit ${floorOf(p)}`).join(', ')} — authored here, and the kit release it names is not cut yet)`
      )
    }
    return 0
  }
  warn(...failures.map(f => `✖ ${f.message}`))
  return 1
}

// ---------------------------------------------------------------- export

/**
 * Copy an installed plugin back out into a plugin repository checkout — the other half of the
 * authoring loop, and the only command that is MEANT to be run inside the kit.
 */
function cmdExport(args, host) {
  const [id, dir] = args.positional
  if (!id || !dir) stop(2, 'error: export needs a plugin id and a target directory', '', USAGE)
  const surface = findSurface(host, id)
  const target = path.resolve(dir)
  mkdirSync(target, { recursive: true })

  let copied = 0
  for (const d of [...surfaceDirectories(surface), `docs/plugins/${id}`]) {
    if (!existsSync(abs(d))) continue
    for (const rel of walk(abs(d))) {
      const file = path.join(target, d, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, readFileSync(abs(`${d}/${rel}`)))
      copied += 1
    }
  }
  const anchor = JSON.parse(readFileSync(abs(surface.anchor), 'utf8'))
  const manifest = {
    ...anchor,
    repo: anchor.repo ?? surface.source?.repo,
    subdir: anchor.subdir ?? surface.source?.subdir ?? '',
    anchor: surface.anchor,
    // **`uses` is DERIVED here, never carried over from the anchor.** It is a measurement of the
    // tree being exported, so re-deriving it is what keeps a plugin's declared surface true of the
    // code it actually ships — the whole reason compatibility is observed rather than predicted.
    uses: usesOf(REPO_ROOT, id),
    minKit: floorOf(anchor),
    paths: surface.paths,
    registries: surface.registries,
  }
  writeFileSync(path.join(target, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  out(
    `✔ ${copied} file(s) + ${PLUGIN_MANIFEST_FILE} written to ${target}`,
    '',
    'That directory is now a plugin repository. `git init && git add -A && git commit` it, then',
    `install it back with \`pnpm plugin add ${target} --local\`.`
  )
  return 0
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  add: cmdAdd,
  upgrade: cmdUpgrade,
  remove: cmdRemove,
  list: cmdList,
  check: cmdCheck,
  export: cmdExport,
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    out(USAGE)
    return 0
  }
  if (args.error) {
    warn(`error: ${args.error}`, '', USAGE)
    return 2
  }
  const command = COMMANDS[args.command]
  if (!command) {
    warn(`error: unknown command '${args.command}'`, '', USAGE)
    return 2
  }
  return command(args, loadHost())
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  if (err instanceof Stop) {
    warn(...err.lines)
    process.exitCode = err.code
  } else {
    warn(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = err?.exitCode ?? 1
  }
}
