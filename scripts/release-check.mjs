#!/usr/bin/env node
/**
 * Refuse a kit release that ships without its porting note — `docs/upgrades/README.md`.
 *
 *   node scripts/release-check.mjs --tag <X.Y.Z>      the hard stop, run by deploy.yml at the tag
 *   node scripts/release-check.mjs --unreleased       the PR gate, run by ci.yml
 *   node scripts/release-check.mjs --deployable       "is there anything here to deploy?" (deploy.yml)
 *   node scripts/release-check.mjs --version-only <parent>   is HEAD only a root-version bump over it?
 *   node scripts/release-check.mjs --gated <sha>      "has CI already passed this?" (deploy.yml `gated`)
 *
 * `--repo-root <path>` on any of them names the repository to check. Without it the root is the git
 * toplevel of the working directory, and only then the directory this script lives in — see
 * `resolveRepoRoot`.
 *
 * A copy of the kit can never merge from upstream; it replays translated diffs guided by these
 * notes. So a release with no note is a release no adopter can cross, and the gap is permanent —
 * `previous` chains through it. That is worth failing a deploy over.
 *
 * `--tag` and `--unreleased` exit 0 immediately when `.rocketflare.json` has an `app` block: that means this is
 * somebody's app, not the kit, and the kit's release discipline is none of its business.
 * `--deployable`, `--version-only` and `--gated` answer deploy questions, so they run everywhere —
 * a copy's deploy.yml is where they matter.
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

/** Where this SCRIPT lives — the last resort, and what the exported helpers default to. */
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (root, p) => readFileSync(path.join(root, p), 'utf8')
const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE = `usage: node scripts/release-check.mjs --tag <X.Y.Z> | --unreleased [--base <ref>] | --deployable
                            | --version-only <parent> | --gated <sha>   [--repo-root <path>]`

/** `git rev-parse --show-toplevel` as an answer or a null: not a checkout, or no git at all. */
function gitToplevel(cwd) {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

/**
 * WHICH repository is being released or checked — a decision, not a constant.
 *
 * It used to be `path.resolve(dirname(import.meta.url), '..')`, so the root was wherever the SCRIPT
 * lived. That is why the first-party plugins repository carries a verbatim copy of this file,
 * `release.mjs` and six `scripts/lib/*.mjs`: a shim that cloned the kit and ran
 * `node .kit/scripts/release-check.mjs` would answer `.kit/` and check the KIT's release rather
 * than the plugin repository's. Four thousand lines of duplicate, already drifting, because one
 * path was computed instead of asked for.
 *
 * Three steps, narrowest first:
 *
 *   1. `--repo-root <path>` — an explicit answer always wins, and is what a shim passes;
 *   2. the git toplevel of the working directory — which is what makes running the kit's copy from
 *      inside another checkout mean that other checkout, and also what makes `cd apps/web && node
 *      ../../scripts/release.mjs` work at all;
 *   3. the directory this script lives in — the original derivation, so the kit running its own
 *      scripts in place is unchanged byte for byte.
 *
 * Returns the remaining argv as `rest` because the flag has to be consumed before either script's
 * option loop sees it — one of them would read it as a version, the other as an unknown option.
 * `gitToplevel` is injected so the whole decision is testable without a filesystem.
 */
export function resolveRepoRoot(
  argv = [],
  { cwd = process.cwd(), scriptRoot = SCRIPT_ROOT, toplevel = gitToplevel } = {}
) {
  const rest = []
  let named = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--repo-root') {
      rest.push(argv[i])
      continue
    }
    const value = argv[++i]
    if (value === undefined || value.startsWith('-')) {
      return { root: scriptRoot, rest, error: '--repo-root needs a path, e.g. --repo-root .' }
    }
    named = value
  }
  if (named !== null) return { root: path.resolve(cwd, named), rest, error: null }
  const top = toplevel(cwd)
  return { root: top ? path.resolve(top) : scriptRoot, rest, error: null }
}

/**
 * Every `X.Y.Z.md` in a notes directory, oldest first.
 *
 * `notesDir` is a parameter because a PLUGIN repository runs the same release machinery over its
 * own notes (D31): a plugin has releases, a chain of `previous` and the same four headings, and
 * one copy of this walk is better than two that drift.
 */
export function releaseNotes(notesDir = 'docs/upgrades', { root = SCRIPT_ROOT } = {}) {
  const dir = path.join(root, notesDir)
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
export function findPluginManifests(root = SCRIPT_ROOT, { maxDepth = 3 } = {}) {
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
function checkNote(root, note, problems, { expectPrevious } = {}) {
  // A PLUGIN repository has no `.rocketflare.json`, and `surfaceIds: null` is the honest answer
  // there rather than reporting every id in the note as unknown: the ids a note may name belong to
  // the KIT's manifest, so with none to read there is nothing to check them against.
  const manifest = existsSync(path.join(root, MANIFEST_FILE))
    ? JSON.parse(read(root, MANIFEST_FILE))
    : null
  problems.push(
    ...noteProblems(read(root, note.file), {
      file: note.file,
      version: note.version,
      expectPrevious,
      surfaceIds: manifest ? manifest.surfaces.map(s => s.id) : null,
      retiredSurfaceIds: manifest?.retiredSurfaces ?? {},
      manifestFile: MANIFEST_FILE,
    })
  )
}

function checkTag(root, tag, problems) {
  if (!VERSION_RE.test(tag)) {
    problems.push(`'${tag}' is not an X.Y.Z version`)
    return
  }
  const rootVersion = JSON.parse(read(root, 'package.json')).version
  if (rootVersion !== tag)
    problems.push(`root package.json version is ${rootVersion}, the tag is ${tag}`)

  const manifest = JSON.parse(read(root, MANIFEST_FILE))
  if (manifest.kit.version !== tag) {
    problems.push(
      `${MANIFEST_FILE} kit.version is ${manifest.kit.version}, the tag is ${tag} — an adopter's --from resolves through it`
    )
  }

  const notes = releaseNotes('docs/upgrades', { root })
  const note = notes.find(n => n.version === tag)
  if (!note) {
    problems.push(
      `docs/upgrades/${tag}.md does not exist — no adopter can upgrade past a release with no porting note. Run \`pnpm kit:release ${tag}\`.`
    )
    return
  }
  const idx = notes.indexOf(note)
  checkNote(root, note, problems, { expectPrevious: idx === 0 ? 'null' : notes[idx - 1].version })

  const changelog = read(root, 'CHANGELOG.md')
  // Anchored: `includes('## 0.6.1')` is also satisfied by `## 0.6.10`, so a two-digit patch would
  // let the tag gate pass on another release's section.
  if (!hasChangelogSection(changelog, tag)) problems.push(`CHANGELOG.md has no '## ${tag}' section`)
  if (!changelog.includes(`docs/upgrades/${tag}.md`))
    problems.push(`CHANGELOG.md does not link docs/upgrades/${tag}.md`)

  const unreleased = read(root, 'docs/upgrades/unreleased.md')
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
function checkPluginTag(root, tag, manifests, problems) {
  if (!VERSION_RE.test(tag)) {
    problems.push(`'${tag}' is not an X.Y.Z version`)
    return
  }
  if (existsSync(path.join(root, 'package.json'))) {
    const rootVersion = JSON.parse(read(root, 'package.json')).version
    if (rootVersion !== tag)
      problems.push(`root package.json version is ${rootVersion}, the tag is ${tag}`)
  }
  const changelog = existsSync(path.join(root, 'CHANGELOG.md')) ? read(root, 'CHANGELOG.md') : ''
  let noted = 0

  for (const file of manifests) {
    const dir = subdirOf(file)
    let declared = {}
    try {
      declared = JSON.parse(read(root, file))
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
    const unreleased = existsSync(path.join(root, unreleasedPath))
      ? read(root, unreleasedPath)
      : null
    const notes = releaseNotes(notesDir, { root })
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
    checkNote(root, note, problems, {
      expectPrevious: idx === 0 ? 'null' : notes[idx - 1].version,
    })
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
export function deployable(root = SCRIPT_ROOT) {
  const manifestPath = path.join(root, MANIFEST_FILE)
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  const tomls = Object.fromEntries(
    ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']
      .filter(f => existsSync(path.join(root, f)))
      .map(f => [f, read(root, f)])
  )
  return isDeployable(manifest, tomls)
}

/**
 * Is HEAD a version-only bump over `parent` — the shape of Launch's `release: X.Y.Z` commit?
 * Pure: every fact is read by `versionOnly` below, so each refusal is testable without git.
 *
 *   parents     HEAD's parent shas (`git rev-list --parents -n 1 HEAD`, minus HEAD itself)
 *   parentSha   `parent`, resolved to a commit sha (null when it does not resolve)
 *   changed     `git diff --name-only --no-renames <parent> HEAD`
 *   before      the parent's root `package.json` text (null when it has none)
 *   after       HEAD's root `package.json` text (null when it has none)
 *
 * Passes only when HEAD has exactly ONE parent and it is `parent`, the diff touches only the root
 * `package.json`, and within it only the top-level `"version"` value — byte for byte, so a
 * reformat, a reordered key or a nested `version` fails too. A diff that changes NOTHING fails:
 * an empty commit is not a version bump, and the rule this serves (deploy.yml `gated`) only has
 * to recognise the one shape Launch writes. Returns the problems, empty when it passes.
 */
export function versionOnlyProblems({ parents, parentSha, changed, before, after }) {
  if (parents.length !== 1) {
    return [
      `HEAD has ${parents.length} parents — a merge or a root commit is never a version-only bump`,
    ]
  }
  if (!parentSha) return ['the parent does not resolve to a commit']
  if (parents[0] !== parentSha) {
    return [`${parentSha.slice(0, 12)} is not HEAD's parent (that is ${parents[0].slice(0, 12)})`]
  }
  if (changed.length === 0) {
    return ['nothing changed between the parent and HEAD — a version-only bump changes the version']
  }
  const problems = []
  const others = changed.filter(f => f !== 'package.json')
  if (others.length > 0) {
    const more = others.length > 5 ? ` (+${others.length - 5} more)` : ''
    problems.push(
      `files other than the root package.json changed: ${others.slice(0, 5).join(', ')}${more}`
    )
  }
  if (!changed.includes('package.json')) {
    problems.push('the root package.json did not change')
    return problems
  }
  if (before === null || after === null) {
    problems.push(
      `the root package.json is missing ${before === null ? 'in the parent' : 'at HEAD'}`
    )
    return problems
  }
  let a
  let b
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch (err) {
    problems.push(`the root package.json is not valid JSON on one side (${err.message})`)
    return problems
  }
  const { version: from, ...restBefore } = a
  const { version: to, ...restAfter } = b
  if (from === to) problems.push(`the version did not change (${String(from)})`)
  const keys = [...new Set([...Object.keys(restBefore), ...Object.keys(restAfter)])].filter(
    k => JSON.stringify(restBefore[k]) !== JSON.stringify(restAfter[k])
  )
  if (keys.length > 0) {
    problems.push(`package.json keys other than "version" changed: ${keys.join(', ')}`)
  } else if (from !== to) {
    // The values agree; now the bytes must too. Exactly one line differs, and it is the version
    // line with nothing but the value substituted — anything else is a reformat.
    const l1 = before.split('\n')
    const l2 = after.split('\n')
    const diff = l1.length === l2.length ? l1.flatMap((l, i) => (l === l2[i] ? [] : [i])) : null
    const line = diff?.length === 1 ? diff[0] : -1
    const ok =
      line !== -1 &&
      /^\s*"version"\s*:/.test(l1[line]) &&
      l1[line].replace(JSON.stringify(from), JSON.stringify(to)) === l2[line]
    if (!ok) {
      problems.push(
        `package.json was reformatted — more than the "version" value changed (${String(from)} → ${String(to)})`
      )
    }
  }
  return problems
}

/** `git <args>` in `root`, trimmed — or null when git fails (an unknown ref, a missing path). */
function gitOut(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * The I/O half of `versionOnlyProblems`: read the five facts from git, at the COMMITTED state of
 * HEAD (never the working tree). Needs `parent` in the clone — `fetch-depth: 2` in a workflow.
 * `git` is injected for tests.
 */
export function versionOnly(root, parent, { git = gitOut } = {}) {
  const parentSha =
    git(root, ['rev-parse', '--verify', '--quiet', `${parent}^{commit}`])?.trim() || null
  const line = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])?.trim() ?? ''
  const parents = line.split(/\s+/).filter(Boolean).slice(1)
  const changed =
    parentSha === null
      ? []
      : (git(root, ['diff', '--name-only', '--no-renames', parentSha, 'HEAD']) ?? '')
          .split('\n')
          .map(f => f.trim())
          .filter(Boolean)
  return {
    parent: parentSha,
    problems: versionOnlyProblems({
      parents,
      parentSha,
      changed,
      before: parentSha === null ? null : git(root, ['show', `${parentSha}:package.json`]),
      after: git(root, ['show', 'HEAD:package.json']),
    }),
  }
}

/**
 * How many COMPLETED, SUCCESSFUL `ci.yml` runs from a `push` or a `pull_request` exist on exactly
 * `sha` — through `gh api`, as the `gated` job's shell did. Null on ANY doubt (the API errors, the
 * answer is not the expected shape), which `gatedDecision` reads as "no proof". `exec` is injected
 * for tests.
 */
export function successfulCiRuns(repo, sha, { exec = execFileSync } = {}) {
  try {
    const body = exec(
      'gh',
      [
        'api',
        `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const runs = JSON.parse(body)?.workflow_runs
    if (!Array.isArray(runs)) return null
    return runs.filter(
      r =>
        (r?.event === 'push' || r?.event === 'pull_request') &&
        r?.conclusion === 'success' &&
        r?.head_sha === sha
    ).length
  } catch {
    return null
  }
}

/**
 * deploy.yml's `gated` answer: may this commit deploy on an EARLIER CI verdict instead of running
 * the gate again? Yes when either
 *
 *   (a) `sha` itself has a successful CI run, or
 *   (b) `sha` is a version-only bump over its one parent (`versionOnly`), and THAT parent has one.
 *
 * (b) is Launch's release: it commits `release: X.Y.Z` (the root version, nothing else) over a
 * commit its ship gate and CI already passed, then tags it — and the bump's own CI is still
 * running, or skipped, when the tag's deploy asks. A version bump changes no code the gate tests,
 * so the parent's verdict is the bump's. A run in progress never counts, for either commit; any
 * doubt answers `gated: false`, so the fallback is always the gate. `runs(sha)` → a count or null,
 * `versionOnly()` → `{ parent, problems }`, both injected.
 */
export function gatedDecision({ sha, runs, versionOnly: check }) {
  const own = runs(sha)
  if (own === null) out(`::warning::Could not read CI runs for ${sha}.`)
  if (own !== null && own > 0) {
    return { gated: true, reason: `${sha} already has ${own} successful CI run(s)` }
  }
  let vo
  try {
    vo = check()
  } catch (err) {
    vo = { parent: null, problems: [err instanceof Error ? err.message : String(err)] }
  }
  if (vo.problems.length > 0 || !vo.parent) {
    return {
      gated: false,
      reason: `${sha} has no successful CI run yet, and is not a version-only bump over a gated parent (${vo.problems.join('; ')})`,
    }
  }
  const parentRuns = runs(vo.parent)
  if (parentRuns === null) out(`::warning::Could not read CI runs for ${vo.parent}.`)
  if (parentRuns !== null && parentRuns > 0) {
    return {
      gated: true,
      reason: `${sha} is a version-only bump over ${vo.parent}, which has ${parentRuns} successful CI run(s)`,
    }
  }
  return {
    gated: false,
    reason: `${sha} is a version-only bump, but its parent ${vo.parent} has no successful CI run yet`,
  }
}

function checkUnreleased(root, base, problems, pluginManifests = []) {
  let changed = []
  try {
    const range = base ? `${base}...HEAD` : 'HEAD~1...HEAD'
    changed = execFileSync('git', ['diff', '--name-only', range], {
      cwd: root,
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
  const { root, rest, error } = resolveRepoRoot(argv)
  if (error) {
    warn(`error: ${error}`, '', USAGE)
    return 2
  }
  let mode = null
  let tag = null
  let base = null
  let ref = null
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--tag') {
      mode = 'tag'
      tag = rest[++i]
    } else if (rest[i] === '--version-only' || rest[i] === '--gated') {
      mode = rest[i].slice(2)
      ref = rest[++i]
      if (ref === undefined || ref.startsWith('-')) {
        warn(`error: ${rest[i - 1]} needs a commit`, '', USAGE)
        return 2
      }
    } else if (rest[i] === '--unreleased') mode = 'unreleased'
    else if (rest[i] === '--deployable') mode = 'deployable'
    else if (rest[i] === '--base') base = rest[++i]
    else if (rest[i] === '-h' || rest[i] === '--help') {
      out(USAGE)
      return 0
    } else {
      warn(`error: unknown option '${rest[i]}'`, '', USAGE)
      return 2
    }
  }
  if (!mode) {
    warn(USAGE)
    return 2
  }
  if (mode === 'deployable') {
    const { deployable: ok, reason } = deployable(root)
    // The workflow reads this line; `::notice::` puts the reason in the run summary, so a skipped
    // deploy explains itself instead of looking like something went wrong.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `deployable=${ok}\n`)
    }
    // And the run page's summary, which is what a person opening a green-but-empty run reads: the
    // gate is skipped too when there is nothing to deploy, so this line is the whole run.
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ok
          ? `Deploying: ${reason}.\n`
          : `**Nothing to deploy** — ${reason}. The gate was not run.\n`
      )
    }
    out(ok ? `deployable=true — ${reason}` : `::notice::Deploy skipped: ${reason}.`)
    if (!ok) out('deployable=false')
    return 0
  }
  if (mode === 'version-only') {
    const { problems } = versionOnly(root, ref)
    if (problems.length > 0) {
      warn(
        `release-check: HEAD is not a version-only bump over ${ref}:`,
        ...problems.map(p => `  ${p}`)
      )
      return 1
    }
    out(`release-check ok — HEAD changes only the root package.json "version" over ${ref}`)
    return 0
  }
  if (mode === 'gated') {
    // Never fails the job: every doubt is `gated=false`, and the deploy then runs the gate itself.
    const repo = process.env.GITHUB_REPOSITORY ?? ''
    const { gated, reason } = gatedDecision({
      sha: ref,
      runs: sha => (repo ? successfulCiRuns(repo, sha) : null),
      versionOnly: () => {
        const head = gitOut(root, ['rev-parse', 'HEAD'])?.trim()
        if (head !== ref) {
          return { parent: null, problems: [`the checkout is at ${head ?? 'nothing'}, not ${ref}`] }
        }
        return versionOnly(root, 'HEAD^')
      },
    })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `gated=${gated}\n`)
    out(gated ? `${reason}; the gate is not re-run.` : `${reason}; gating it here.`)
    return 0
  }
  // A PLUGIN repository (D31) has no `.rocketflare.json` and one or more `rocketflare-plugin.json`.
  // DISCOVERED rather than named by a flag, deliberately: this is a gate, and a flag can be
  // forgotten — a plugin whose version nobody stamped is precisely what it exists to catch.
  const hasManifest = existsSync(path.join(root, MANIFEST_FILE))
  const pluginManifests = hasManifest ? [] : findPluginManifests(root)
  if (!hasManifest && pluginManifests.length === 0) {
    out(`release-check: no ${MANIFEST_FILE} — nothing to check`)
    return 0
  }
  if (hasManifest && !isKitManifest(JSON.parse(read(root, MANIFEST_FILE)))) {
    out('release-check: this is an app, not the kit — skipped')
    return 0
  }

  const problems = []
  if (mode === 'tag') {
    if (!tag) {
      warn('error: --tag needs a version', '', USAGE)
      return 2
    }
    if (hasManifest) checkTag(root, tag, problems)
    else checkPluginTag(root, tag, pluginManifests, problems)
  } else {
    checkUnreleased(root, base, problems, pluginManifests)
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
