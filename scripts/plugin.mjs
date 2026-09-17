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
  notesBetween,
} from './lib/git-lib.mjs'
import { pluginSurfaces, readManifest } from './lib/manifest.mjs'
import {
  addBarrelLine,
  archiveSql,
  BARREL_KINDS,
  BARRELS,
  barrelLines,
  buildPluginSurface,
  checkRequirements,
  classifyPluginFile,
  hasBarrelLine,
  isVendored,
  PLUGIN_MANIFEST_FILE,
  parsePluginRequirement,
  pluginIdProblem,
  pluginPlatformProblems,
  pluginRoots,
  removeBarrelLine,
  renderAddPlan,
  renderList,
  surfaceDirectories,
} from './lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, isBinary } from './lib/rename-lib.mjs'
import {
  countLines,
  parseNote,
  satisfies,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from './lib/upgrade-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK_DIR = path.join('.upgrade', 'plugins')

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

const mirrorDirFor = repo =>
  abs(
    path.join(
      WORK_DIR,
      `${repo
        .replace(/\.git$/, '')
        .split(/[/:]/)
        .filter(Boolean)
        .pop()}.git`
    )
  )

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
  const m = ensureMirror(target, mirrorDirFor(target), { fetch: args.fetch, cwd: REPO_ROOT, warn })
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
      'That file is what makes a repository a plugin: it declares the id, the version, the kit range',
      'it supports and everything the host has to place by hand (bindings, crons, vars).'
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
  const subdir = m.subdir ?? source.subdir ?? ''
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

  const problems = checkRequirements({
    requires: m.requires,
    kitVersion: host.kitVersion,
    presentSurfaces: host.presentSurfaces,
    installedPlugins: host.plugins.map(p => ({ id: p.id, version: p.source?.version ?? null })),
    vendored,
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
    files,
    byRoot,
    barrels,
    verify: verifyText(source, m.version),
  }
  out(...renderAddPlan(plan))

  if (problems.length > 0) {
    warn('', `error: ${problems.length} requirement(s) unmet — nothing written.`)
    return 6
  }
  if (!args.apply) {
    out('', 'Nothing written. Read the plan, then re-run with --apply to install.')
    return 0
  }

  // --- apply
  let written = 0
  for (const f of files) {
    if (f.role !== 'copy' && f.role !== 'note') continue
    writeInto(f.target, materialise(source.read(f.path), host.names))
    written += 1
  }
  for (const kind of barrels) {
    const file = abs(BARRELS[kind].file)
    writeFileSync(file, addBarrelLine(readFileSync(file, 'utf8'), kind, m.id))
  }
  installDependencies(m, 'add')
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
    `✔ surface '${m.id}' recorded in ${path.relative(REPO_ROOT, recordedIn)}`,
    '',
    'Now do the "by hand" steps above — the schema migration first; nothing else can run until the',
    'tables exist. Then `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.'
  )
  return 0
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

  const m = ensureMirror(source.repo, mirrorDirFor(source.repo), {
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
  const floors = noteFacts.filter(
    n => n.requires_kit && !satisfies(host.kitVersion, n.requires_kit)
  )
  if (floors.length > 0) {
    warn(
      '',
      `error: this kit is ${host.kitVersion}, and these plugin releases need more:`,
      ...floors.map(n => `  ${n.version} requires kit ${n.requires_kit}`),
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

  out(
    '',
    `✔ ${added.length} added, ${patches.length - rejected} patched` +
      (rejected > 0 ? `, ${rejected} with rejects (*.rej beside the file)` : '')
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
      `error: ${dependents.map(d => `'${d.id}'`).join(', ')} require '${id}'.`,
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

  out(
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
  if (tables.length > 0) {
    out(
      '',
      'Tables — `pnpm db:generate` will emit DROP TABLE for each, which is correct here (the kit',
      'warns about a foreign SNAPSHOT, not about your own barrel shrinking). Orphaned tables are',
      'not a stable state:',
      ...tables.map(t => `  ${t}`),
      args.archive
        ? '  --archive: they are copied into schema "archive" by a --custom migration first'
        : '  pass --archive to copy them into schema "archive" before they go'
    )
  }
  const deps = Object.entries(anchorManifest.dependencies ?? {}).filter(
    ([, d]) => Object.keys(d ?? {}).length > 0
  )
  if (deps.length > 0) {
    out('', 'Dependencies — run these YOURSELF if nothing else has started using them:')
    installDependencies(anchorManifest, 'remove')
  }
  // Provisioning creates a plugin's platform resources (decision 12) but deliberately never
  // deletes one: `patch-toml.ts` has no delete-block op, and it should not — a live bucket or
  // queue with somebody's data in it is not something a script removes because a directory went.
  const bindings = anchorManifest.bindings ?? []
  const crons = anchorManifest.crons ?? []
  const prefixes = anchorManifest.apiPrefixes ?? []
  const vars = anchorManifest.vars ?? []
  if (bindings.length + crons.length + prefixes.length + vars.length > 0) {
    out('', 'To deprovision BY HAND — nothing below is removed for you:')
    for (const b of bindings) {
      out(
        `  ${b.type} binding ${b.binding ?? b.name}: delete its block from BOTH tomls, then delete the resource in Cloudflare`
      )
    }
    for (const c of crons)
      out(`  cron "${c.cron ?? c}": remove from [triggers] crons in BOTH tomls`)
    for (const p of prefixes) {
      out(`  route prefix ${p}: remove from [assets] run_worker_first in BOTH tomls`)
    }
    for (const v of vars) {
      const key = v.key ?? v.name ?? v
      out(
        v.secret
          ? `  secret ${key}: \`wrangler secret delete ${key}\` per environment, and drop it from .dev.vars(.example)`
          : `  [vars] ${key}: remove from BOTH tomls (the parity test compares the KEYS) and .dev.vars.example`
      )
    }
  }

  if (!args.apply) {
    out('', 'Nothing written. Re-run with --apply to remove it.')
    return 0
  }

  if (args.archive && tables.length > 0) writeArchiveMigration(id, tables)
  for (const d of directories) rmSync(abs(d), { recursive: true, force: true })
  for (const kind of barrels) {
    const file = abs(BARRELS[kind].file)
    writeFileSync(file, removeBarrelLine(readFileSync(file, 'utf8'), kind, id))
  }
  const dropped = dropSurface(host, id)
  out(
    '',
    `✔ ${directories.length} director(ies) deleted`,
    `✔ ${barrels.length} barrel line(s) removed`,
    `✔ surface dropped from ${dropped.map(f => path.basename(f)).join(', ') || '(nowhere — it was not recorded)'}`,
    '',
    ...(tables.length > 0
      ? [
          `Next: pnpm db:generate --name plugin-${id}-remove   → read the DROP TABLE SQL → pnpm db:migrate`,
        ]
      : []),
    'Then: pnpm lint && pnpm typecheck && pnpm test && pnpm build'
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

// ---------------------------------------------------------------- list / check

function cmdList(_args, host) {
  out(...renderList(host.plugins, { sidecarIds: host.sidecarIds }))
  return 0
}

/**
 * Audit every installed plugin. One line per failure and exit 1 on any — this is the thing
 * `/rf-preflight` and CI run, so it says what is wrong rather than how to fix it.
 */
function cmdCheck(_args, host) {
  const failures = []
  for (const s of host.plugins) {
    const id = s.id
    const vendored = isVendored(s.source, host.kitRepo)
    if (!existsSync(abs(s.anchor))) {
      failures.push(
        `${id}: anchor ${s.anchor} is missing — the surface says installed, the tree says no`
      )
      continue
    }
    // A vendored plugin is version-locked to the kit it ships inside, so its range describes that
    // kit rather than a claim about compatibility. Checking it makes the kit fail against itself
    // for the whole of the release in which the range is raised.
    for (const problem of checkRequirements({
      requires: s.requires,
      kitVersion: host.kitVersion,
      presentSurfaces: host.presentSurfaces,
      installedPlugins: host.plugins.map(p => ({ id: p.id, version: p.source?.version ?? null })),
      vendored,
    })) {
      failures.push(`${id}: ${problem}`)
    }
    for (const kind of BARREL_KINDS) {
      const ships = existsSync(abs(BARRELS[kind].half(id)))
      const wired = hasBarrelLine(readFileSync(abs(BARRELS[kind].file), 'utf8'), kind, id)
      if (ships && !wired)
        failures.push(
          `${id}: ${BARRELS[kind].file} has no line for it, but ${BARRELS[kind].half(id)} is there`
        )
      if (!ships && wired)
        failures.push(
          `${id}: ${BARRELS[kind].file} names it, but ${BARRELS[kind].half(id)} is not there`
        )
    }
    const rejects = surfaceDirectories(s)
      .filter(d => existsSync(abs(d)))
      .flatMap(d => walk(abs(d)).map(f => `${d}/${f}`))
      .filter(f => f.endsWith('.rej'))
    for (const f of rejects) failures.push(`${id}: ${f} — an upgrade left work behind`)

    const anchor = JSON.parse(readFileSync(abs(s.anchor), 'utf8'))
    if (anchor.version && s.source?.version && anchor.version !== s.source.version) {
      failures.push(
        `${id}: the surface says ${s.source.version}, ${s.anchor} says ${anchor.version}`
      )
    }
    if ((anchor.schema?.tables ?? []).length > 0) {
      const tags = JSON.parse(
        readFileSync(abs('apps/web/migrations/meta/_journal.json'), 'utf8')
      ).entries.map(e => e.tag)
      if (!tags.some(t => t.includes(`plugin-${id}`))) {
        failures.push(
          `${id}: declares tables (${anchor.schema.tables.join(', ')}) and no migration names it — run \`pnpm db:generate --name plugin-${id}-${anchor.version ?? '0.0.0'}\``
        )
      }
    }
  }
  if (host.plugins.length === 0) {
    out('No plugins installed — nothing to check.')
    return 0
  }
  if (failures.length === 0) {
    out(`✔ ${host.plugins.length} plugin(s) check out: ${host.plugins.map(p => p.id).join(', ')}`)
    const vendored = host.plugins.filter(p => isVendored(p.source, host.kitRepo)).map(p => p.id)
    if (vendored.length > 0) {
      out(
        `  (${vendored.join(', ')} vendored — shipped inside the kit, so requires.kit is not checked)`
      )
    }
    return 0
  }
  warn(...failures.map(f => `✖ ${f}`))
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
