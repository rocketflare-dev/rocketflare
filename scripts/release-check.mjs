#!/usr/bin/env node
/**
 * Refuse a kit release that ships without its porting note — `docs/upgrades/README.md`.
 *
 *   node scripts/release-check.mjs --tag <X.Y.Z>      the hard stop, run by deploy.yml at the tag
 *   node scripts/release-check.mjs --unreleased       the PR gate, run by ci.yml
 *   node scripts/release-check.mjs --deployable       "is there anything here to deploy?" (deploy.yml)
 *
 * A copy of the kit can never merge from upstream; it replays translated diffs guided by these
 * notes. So a release with no note is a release no adopter can cross, and the gap is permanent —
 * `previous` chains through it. That is worth failing a deploy over.
 *
 * Both modes exit 0 immediately when `.rocketflare.json` has an `app` block: that means this is
 * somebody's app, not the kit, and the kit's release discipline is none of its business.
 *
 * Exit 0 ok · 1 a check failed · 2 usage.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFEST_FILE } from './lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from './lib/plugin-lib.mjs'
import {
  behaviourFiles,
  compareVersions,
  hasChangelogSection,
  isDeployable,
  isKitManifest,
  noteProblems,
  VERSION_RE,
} from './lib/upgrade-lib.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(path.join(REPO_ROOT, p), 'utf8')
const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE = `usage: node scripts/release-check.mjs --tag <X.Y.Z> | --unreleased [--base <ref>] | --deployable`

/**
 * Every `X.Y.Z.md` in a notes directory, oldest first.
 *
 * `notesDir` is a parameter because a PLUGIN repository runs the same release machinery over its
 * own notes (D31): a plugin has releases, a chain of `previous` and the same four headings, and
 * one copy of this walk is better than two that drift.
 */
export function releaseNotes(notesDir = 'docs/upgrades') {
  const dir = path.join(REPO_ROOT, notesDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => VERSION_RE.test(f.replace(/\.md$/, '')))
    .map(f => ({ version: f.replace(/\.md$/, ''), file: `${notesDir}/${f}` }))
    .sort((a, b) => compareVersions(a.version, b.version))
}

/** Directory names a manifest scan never descends into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])

/**
 * Every `rocketflare-plugin.json` in a checkout, repo-root-relative and sorted (D31).
 *
 * A plugin MONOREPO — `rocketflare-plugins` — holds `plugins/<id>/rocketflare-plugin.json` and
 * nothing at the root, and one release covers every plugin in it at one version. So both the
 * release script and this gate have to find them all rather than look in one place: a manifest left
 * at an older number is not cosmetic, because `pnpm plugin check` compares an installed surface's
 * recorded version against the anchor manifest and would report a mismatch for every install of
 * that plugin.
 *
 * A bounded WALK rather than a glob of `plugins/*`: `--plugin` takes an arbitrary subdirectory, so
 * hardcoding one repository's layout would make the flag a lie. It skips dot-directories and the
 * build noise, stops at `maxDepth` (the layout is `<group>/<id>/`, so 2 suffices and 3 is headroom)
 * and never descends INTO a plugin it has found — a plugin's tree mirrors a host app, and there is
 * nothing below it this needs. A single-plugin repository answers `[PLUGIN_MANIFEST_FILE]`, which
 * is exactly the list that was written out by hand before.
 */
export function findPluginManifests(root = REPO_ROOT, { maxDepth = 3 } = {}) {
  const found = []
  const walk = (dir, rel, depth) => {
    if (existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))) {
      found.push(rel === '' ? PLUGIN_MANIFEST_FILE : `${rel}/${PLUGIN_MANIFEST_FILE}`)
      return
    }
    if (depth >= maxDepth) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), rel === '' ? entry.name : `${rel}/${entry.name}`, depth + 1)
    }
  }
  walk(root, '', 0)
  return found.sort()
}

/** `plugins/analytics/rocketflare-plugin.json` → `plugins/analytics`; a root manifest → `''`. */
function subdirOf(manifestFile) {
  const dir = path.posix.dirname(manifestFile)
  return dir === '.' ? '' : dir
}

/**
 * The note schema is `noteProblems` in `scripts/lib/upgrade-lib.mjs` — this is the I/O around it.
 *
 * It used to be stated here in full, and separately in `upgrade-notes.test.ts`, and the two had
 * drifted: the test accepted a surface a later release RETIRED, this did not, so the tag gate
 * called `docs/upgrades/0.2.0.md` and `0.3.0.md` broken over `feature-analytics` — notes the kit
 * forbids rewriting. `retiredSurfaces` in the manifest is now the one list, and both read it.
 */
function checkNote(note, problems, { expectPrevious } = {}) {
  // A PLUGIN repository has no `.rocketflare.json`, and `surfaceIds: null` is the honest answer
  // there rather than reporting every id in the note as unknown: the ids a note may name belong to
  // the KIT's manifest, so with none to read there is nothing to check them against.
  const manifest = existsSync(path.join(REPO_ROOT, MANIFEST_FILE))
    ? JSON.parse(read(MANIFEST_FILE))
    : null
  problems.push(
    ...noteProblems(read(note.file), {
      file: note.file,
      version: note.version,
      expectPrevious,
      surfaceIds: manifest ? manifest.surfaces.map(s => s.id) : null,
      retiredSurfaceIds: manifest?.retiredSurfaces ?? {},
      manifestFile: MANIFEST_FILE,
    })
  )
}

function checkTag(tag, problems) {
  if (!VERSION_RE.test(tag)) {
    problems.push(`'${tag}' is not an X.Y.Z version`)
    return
  }
  const rootVersion = JSON.parse(read('package.json')).version
  if (rootVersion !== tag)
    problems.push(`root package.json version is ${rootVersion}, the tag is ${tag}`)

  const manifest = JSON.parse(read(MANIFEST_FILE))
  if (manifest.kit.version !== tag) {
    problems.push(
      `${MANIFEST_FILE} kit.version is ${manifest.kit.version}, the tag is ${tag} — an adopter's --from resolves through it`
    )
  }

  const notes = releaseNotes()
  const note = notes.find(n => n.version === tag)
  if (!note) {
    problems.push(
      `docs/upgrades/${tag}.md does not exist — no adopter can upgrade past a release with no porting note. Run \`pnpm kit:release ${tag}\`.`
    )
    return
  }
  const idx = notes.indexOf(note)
  checkNote(note, problems, { expectPrevious: idx === 0 ? 'null' : notes[idx - 1].version })

  const changelog = read('CHANGELOG.md')
  // Anchored: `includes('## 0.6.1')` is also satisfied by `## 0.6.10`, so a two-digit patch would
  // let the tag gate pass on another release's section.
  if (!hasChangelogSection(changelog, tag)) problems.push(`CHANGELOG.md has no '## ${tag}' section`)
  if (!changelog.includes(`docs/upgrades/${tag}.md`))
    problems.push(`CHANGELOG.md does not link docs/upgrades/${tag}.md`)

  const unreleased = read('docs/upgrades/unreleased.md')
  if (!/_Nothing yet\./.test(unreleased)) {
    problems.push('docs/upgrades/unreleased.md still has entries — they belong in the release note')
  }
  if (!unreleased.includes(`previous: ${tag}`)) {
    problems.push(`docs/upgrades/unreleased.md should now read 'previous: ${tag}'`)
  }
}

/**
 * The same four release facts, for a PLUGIN repository (D31): one version, one tag, a porting note
 * per plugin that changed, and a changelog that links each of them.
 *
 * **Lockstep is checked here and nowhere else.** Every plugin in the repository ships at the
 * repository's version, so a manifest still carrying the previous number is a hard failure — that
 * number is what `pnpm plugin check` compares an installed surface against, so leaving one behind
 * makes every install of that plugin report a mismatch it cannot explain.
 *
 * A plugin whose files did not change needs no note: its `previous` chain simply skips a version,
 * which is still unbroken. Entries left in its `unreleased.md` are the other case entirely, and
 * that IS the permanent gap this gate exists to refuse — so those two are distinguished rather
 * than conflated into "every plugin must have a note".
 */
function checkPluginTag(tag, manifests, problems) {
  if (!VERSION_RE.test(tag)) {
    problems.push(`'${tag}' is not an X.Y.Z version`)
    return
  }
  if (existsSync(path.join(REPO_ROOT, 'package.json'))) {
    const rootVersion = JSON.parse(read('package.json')).version
    if (rootVersion !== tag)
      problems.push(`root package.json version is ${rootVersion}, the tag is ${tag}`)
  }
  const changelog = existsSync(path.join(REPO_ROOT, 'CHANGELOG.md')) ? read('CHANGELOG.md') : ''
  let noted = 0

  for (const file of manifests) {
    const dir = subdirOf(file)
    let declared = {}
    try {
      declared = JSON.parse(read(file))
    } catch {
      problems.push(`${file} is not valid JSON`)
      continue
    }
    if (declared.version !== tag) {
      problems.push(
        `${file} version is ${declared.version}, the tag is ${tag} — every plugin here ships at the repository's version`
      )
    }

    const notesDir = dir === '' ? 'docs/upgrades' : `${dir}/docs/upgrades`
    const unreleasedPath = `${notesDir}/unreleased.md`
    const unreleased = existsSync(path.join(REPO_ROOT, unreleasedPath))
      ? read(unreleasedPath)
      : null
    const notes = releaseNotes(notesDir)
    const note = notes.find(n => n.version === tag)

    if (!note) {
      if (unreleased !== null && !/_Nothing yet\./.test(unreleased)) {
        problems.push(
          `${unreleasedPath} has entries but there is no ${notesDir}/${tag}.md — release them, or move them out`
        )
      }
      continue
    }
    noted++
    const idx = notes.indexOf(note)
    checkNote(note, problems, { expectPrevious: idx === 0 ? 'null' : notes[idx - 1].version })
    if (!changelog.includes(note.file)) problems.push(`CHANGELOG.md does not link ${note.file}`)
    if (unreleased === null) problems.push(`${unreleasedPath} does not exist`)
    else {
      if (!/_Nothing yet\./.test(unreleased)) {
        problems.push(`${unreleasedPath} still has entries — they belong in the release note`)
      }
      if (!unreleased.includes(`previous: ${tag}`)) {
        problems.push(`${unreleasedPath} should now read 'previous: ${tag}'`)
      }
    }
  }

  if (!hasChangelogSection(changelog, tag)) problems.push(`CHANGELOG.md has no '## ${tag}' section`)
  if (noted === 0) {
    problems.push(
      `no plugin here has a docs/upgrades/${tag}.md — a release nobody can port is a permanent gap in the chain \`pnpm plugin upgrade\` walks`
    )
  }
}

/** The I/O half of `isDeployable`: read the manifest and both tomls, then ask the pure function. */
export function deployable() {
  const manifestPath = path.join(REPO_ROOT, MANIFEST_FILE)
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  const tomls = Object.fromEntries(
    ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']
      .filter(f => existsSync(path.join(REPO_ROOT, f)))
      .map(f => [f, read(f)])
  )
  return isDeployable(manifest, tomls)
}

function checkUnreleased(base, problems, pluginManifests = []) {
  let changed = []
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~1...HEAD'
    changed = execFileSync('git', ['diff', '--name-only', range], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    out('release-check: cannot resolve the diff range — skipping the unreleased check')
    return
  }
  // The same predicate the pre-commit hook uses (`scripts/changelog-nudge.mjs`) — they were two
  // copies of one regex pair, and a hook that disagrees with the gate is a hook people learn to
  // ignore.
  // ONE rule, asked once in the kit and once per PLUGIN in a monorepo. `within` is what makes the
  // second case work at all: there a plugin's source is `plugins/<id>/apps/web/...`, which the bare
  // `^(apps|packages)/` predicate does not match — so without it the gate would pass silently on
  // every change it was written to catch, which looks exactly like success.
  const scopes = pluginManifests.length === 0 ? [''] : pluginManifests.map(subdirOf)
  let recorded = 0
  for (const within of scopes) {
    const behaviour = behaviourFiles(changed, { within })
    if (behaviour.length === 0) continue
    recorded++
    const where = within === '' ? 'apps/ or packages/' : `${within}/`
    const notePath =
      within === '' ? 'docs/upgrades/unreleased.md' : `${within}/docs/upgrades/unreleased.md`
    if (changed.includes(notePath)) continue
    problems.push(
      `${behaviour.length} file(s) under ${where} changed without an entry in ${notePath}.`,
      'An adopter ports this change by reading that note; without it the change is invisible to every copy.',
      `First few: ${behaviour.slice(0, 5).join(', ')}`
    )
  }
  if (recorded === 0) {
    out('release-check: no behaviour change in apps/ or packages/ — nothing to record')
  }
}

function main(argv) {
  let mode = null
  let tag = null
  let base = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') {
      mode = 'tag'
      tag = argv[++i]
    } else if (argv[i] === '--unreleased') mode = 'unreleased'
    else if (argv[i] === '--deployable') mode = 'deployable'
    else if (argv[i] === '--base') base = argv[++i]
    else if (argv[i] === '-h' || argv[i] === '--help') {
      out(USAGE)
      return 0
    } else {
      warn(`error: unknown option '${argv[i]}'`, '', USAGE)
      return 2
    }
  }
  if (!mode) {
    warn(USAGE)
    return 2
  }
  if (mode === 'deployable') {
    const { deployable: ok, reason } = deployable()
    // The workflow reads this line; `::notice::` puts the reason in the run summary, so a skipped
    // deploy explains itself instead of looking like something went wrong.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `deployable=${ok}\n`)
    }
    out(ok ? `deployable=true — ${reason}` : `::notice::Deploy skipped: ${reason}.`)
    if (!ok) out('deployable=false')
    return 0
  }
  // A PLUGIN repository (D31) has no `.rocketflare.json` and one or more `rocketflare-plugin.json`.
  // DISCOVERED rather than named by a flag, deliberately: this is a gate, and a flag can be
  // forgotten — a plugin whose version nobody stamped is precisely what it exists to catch.
  const hasManifest = existsSync(path.join(REPO_ROOT, MANIFEST_FILE))
  const pluginManifests = hasManifest ? [] : findPluginManifests(REPO_ROOT)
  if (!hasManifest && pluginManifests.length === 0) {
    out(`release-check: no ${MANIFEST_FILE} — nothing to check`)
    return 0
  }
  if (hasManifest && !isKitManifest(JSON.parse(read(MANIFEST_FILE)))) {
    out('release-check: this is an app, not the kit — skipped')
    return 0
  }

  const problems = []
  if (mode === 'tag') {
    if (!tag) {
      warn('error: --tag needs a version', '', USAGE)
      return 2
    }
    if (hasManifest) checkTag(tag, problems)
    else checkPluginTag(tag, pluginManifests, problems)
  } else {
    checkUnreleased(base, problems, pluginManifests)
  }

  if (problems.length > 0) {
    warn('release-check failed:', ...problems.map(p => `  ${p}`))
    return 1
  }
  out(
    mode === 'tag'
      ? `release-check ok — ${tag} has its porting note, changelog entry and version stamps`
      : 'release-check ok'
  )
  return 0
}

// Guarded so `scripts/release.mjs` can import `releaseNotes` without running the checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    warn(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
