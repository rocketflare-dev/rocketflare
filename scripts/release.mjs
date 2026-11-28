#!/usr/bin/env node
/**
 * Cut a release — the mechanical half, so `scripts/release-check.mjs` passes by construction.
 *
 *   node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run] [--skip-plugin-check]
 *
 * WHICH repository it releases is `resolveRepoRoot` (`release-check.mjs`): `--repo-root <path>`,
 * else the git toplevel of the working directory, else the directory this script lives in.
 *
 * Folds every pending fragment (`docs/upgrades/unreleased/<slug>.md`, one per pull request) and
 * `docs/upgrades/unreleased.md`, when it has entries, into `docs/upgrades/X.Y.Z.md` (`mergeNotes`),
 * fills its `version`, `previous` and `date`, bumps every version file, prepends a `CHANGELOG.md`
 * section, deletes the fragments and writes a fresh empty `unreleased.md`. With no fragment the
 * legacy file is the note, byte for byte, as before fragments existed.
 *
 * Then: commit, `git tag -m "Release X.Y.Z" X.Y.Z && git push origin main X.Y.Z` (docs/DEPLOY.md,
 * "The release dance"); for the kit, also the site's changelog (CONTRIBUTING.md, "Cutting a release").
 *
 * **Two kinds of repository run this** (D31). The kit stamps the root `package.json` and
 * `.rocketflare.json`'s `kit.version`; a PLUGIN repository — a checkout with a
 * `rocketflare-plugin.json` and no `.rocketflare.json` — stamps every plugin manifest in it and its
 * `package.json` if it has one. Everything else is identical, because a plugin's releases are read
 * by exactly the same machinery: `previous` chains, the four headings, and `pnpm plugin upgrade`
 * walking the notes between two commits. `releaseContext()` is the whole of the difference.
 *
 * `--plugin <subdir>` (repeatable) resolves that context INSIDE a subdirectory, which is the whole
 * of what a plugin MONOREPO needs: `rocketflare-plugins` holds `plugins/<id>/rocketflare-plugin.json`
 * and nothing at the root, so without it `releaseContext()` answers `unknown` and this exits 1.
 * Every plugin in such a repository ships at ONE version and is tagged plain `X.Y.Z`, with no
 * prefix and no per-plugin namespacing — a tag has to stay resolvable by `ls-remote <repo> <ref>`,
 * which cannot resolve a bare SHA. The accepted cost of that lockstep: a fix to one plugin bumps
 * every plugin's version. Per-plugin tags (`<id>-vX.Y.Z`, #181) are the way off it: `pnpm plugin`,
 * the CI-plugin check below and the plugin matrix already read either form, a plugin's newest
 * release being whichever of its own tag and the lockstep tag is the higher version.
 *
 * In the KIT it additionally refuses a version its CI plugins (`defaultPlugins` plus
 * `.github/ci-plugins.json`) are not ready for (D31, decision 5): every entry must still resolve
 * at the ref the kit pins, and the version being cut must be at or above the `minKit` floor that entry declares. `--skip-plugin-check` is the escape
 * hatch, and it says so loudly.
 *
 * In the KIT it also dispatches the plugin matrix (`.github/workflows/plugin-matrix.yml`, #180)
 * against `main` before anything is written, waits for it at the end (`--matrix-wait`, 10 minutes;
 * 0 = do not wait) and prints `✔` or `⚠ <plugin> fails on main: <step>, <run>` per plugin. It
 * warns and never blocks; without `gh` (or with `--no-matrix`) it says it did not check.
 *
 * In the KIT it also WARNS, never fails, when the changes since the previous tag touch the paths
 * a security audit should see first (`AUDIT_CADENCE_GLOBS`, `docs/SECURITY-AUDIT.md` "Cadence").
 *
 * Exit 0 ok · 1 error · 2 usage.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ciPluginEntries, readCiPlugins } from './default-plugins.mjs'
import { ensureMirror, mirrorDirFor, PLUGIN_MIRROR_ROOT } from './lib/git-lib.mjs'
import { MANIFEST_FILE, readManifest } from './lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from './lib/plugin-lib.mjs'
import {
  changelogSection,
  defaultPluginProblems,
  fragmentProblems,
  fragmentRank,
  fragmentsDir,
  isKitManifest,
  matchesAny,
  NOTE_HEADINGS,
  noteLengthWarning,
  parseNote,
  prependChangelogSection,
  sectionOf,
  VERSION_RE,
} from './lib/upgrade-lib.mjs'
import { jobVerdicts } from './plugin-matrix.mjs'
import {
  findPluginManifests,
  fragmentCheckOptions,
  listFragments,
  releaseNotes,
  resolveRepoRoot,
} from './release-check.mjs'

/** Where this SCRIPT lives — the last resort, and what the exported seams default to. */
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const abs = (root, p) => path.join(root, p)
const read = (root, p) => readFileSync(abs(root, p), 'utf8')
const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE = [
  'usage: node scripts/release.mjs <X.Y.Z> [--plugin <subdir>]... [--date YYYY-MM-DD]',
  '                                [--dry-run] [--skip-plugin-check] [--repo-root <path>]',
  '                                [--no-matrix] [--matrix-wait <minutes>]',
].join('\n')

/** Match `"version": "x"` at the top level of a JSON file (two-space indent, so exactly one). */
const TOP_LEVEL_VERSION = /^( {2}"version":\s*)"[^"]+"/m

/**
 * Which repository is this, and what does a release stamp here?
 *
 * `kit` — `.rocketflare.json` with no `app` block. `app` — somebody's product, whose release
 * discipline is its own. `plugin` — a `rocketflare-plugin.json` at the root (D31), which is the
 * whole of what makes a repository a plugin.
 */
export function releaseContext(root = SCRIPT_ROOT, { repoRoot = root } = {}) {
  const at = p => path.join(root, p)
  // Every path in a context is relative to the REPOSITORY root, because that is what each consumer
  // joins against. For the kit and a single-plugin repository `root` IS the repository
  // root and this is the identity; only a monorepo's `--plugin plugins/<id>` makes it move.
  const rel = p => path.relative(repoRoot, path.join(root, p)).split(path.sep).join('/')

  if (existsSync(at(MANIFEST_FILE))) {
    const manifest = JSON.parse(readFileSync(at(MANIFEST_FILE), 'utf8'))
    if (!isKitManifest(manifest)) return { kind: 'app' }
    return {
      kind: 'kit',
      notesDir: rel('docs/upgrades'),
      changelog: 'CHANGELOG.md',
      versionFiles: [
        { file: 'package.json', pattern: TOP_LEVEL_VERSION, label: 'version' },
        {
          file: MANIFEST_FILE,
          pattern: /("kit":\s*\{[^}]*?"version":\s*)"[^"]+"/,
          label: 'kit.version',
        },
      ],
    }
  }
  if (existsSync(at(PLUGIN_MANIFEST_FILE))) {
    let id = null
    try {
      id = JSON.parse(readFileSync(at(PLUGIN_MANIFEST_FILE), 'utf8')).id ?? null
    } catch {
      // A manifest that will not parse is still a plugin directory; `release-check --tag` is what
      // reports it. Falling back to the directory name keeps the changelog label readable.
      id = path.basename(root)
    }
    // EVERY plugin manifest in the repository, not only this one, plus the root `package.json`.
    // Lockstep: one release, one version, one tag — and a manifest left at the old number is not
    // cosmetic, because it is what a host records as the installed version.
    //
    // The ANCHOR (`apps/web/src/plugins/<id>/plugin.json`) is deliberately NOT stamped, though a
    // release briefly did. It carried the version a second time, by hand, and a stale one failed
    // every install; it is a COPY written by `pnpm plugin add` now, so the duplicate it was
    // compensating for is gone. Stamping a generated file only invites the two to disagree again.
    // `requires.pluginApi` is untouched for a different reason: which kit contract a plugin
    // compiles against is a different question from which release shipped it, and it is nested, so
    // the two-space `TOP_LEVEL_VERSION` anchor cannot reach it.
    const manifests = [...new Set([...findPluginManifests(repoRoot), rel(PLUGIN_MANIFEST_FILE)])]
    return {
      kind: 'plugin',
      id,
      notesDir: rel('docs/upgrades'),
      // The CHANGELOG is the REPOSITORY's, never a plugin's: a monorepo keeps one index for one
      // lockstep version, and in a single-plugin repository this is the same path it always was.
      changelog: 'CHANGELOG.md',
      versionFiles: [
        ...manifests.sort().map(file => ({ file, pattern: TOP_LEVEL_VERSION, label: 'version' })),
        { file: 'package.json', pattern: TOP_LEVEL_VERSION, label: 'version' },
      ],
    }
  }
  return { kind: 'unknown' }
}

/**
 * The paths where a change deserves a security audit before it ships (`docs/SECURITY-AUDIT.md`,
 * "Cadence"): authentication, tenant scoping and row-level security, the identity and plugin
 * seams, and how the model is handed tools. A release touching one prints a WARNING, never a
 * failure, recommending a diff-scoped `standard` audit (`/rf-security standard <prev>..HEAD`).
 */
export const AUDIT_CADENCE_GLOBS = Object.freeze([
  // Authentication: sessions, keys, magic links, OAuth/OIDC providers, the auth routes
  'apps/web/src/api/auth/**',
  'apps/web/src/api/routes/auth/**',
  'apps/web/src/api/middleware/auth.ts',
  'apps/web/src/api/middleware/csrf.ts',
  'apps/web/src/api/middleware/permissions.ts',
  'apps/web/src/api/middleware/public-mounts.ts',
  'apps/web/src/api/services/auth.ts',
  // Tenancy, roles and row-level security
  'apps/web/src/permissions/**',
  'packages/shared/src/permissions.ts',
  'apps/web/src/api/services/access.ts',
  'apps/web/src/api/services/access-sql.ts',
  'apps/web/src/api/services/member-ability.ts',
  'apps/web/src/api/services/idp-tenancy.ts',
  'apps/web/src/db/tenant-scope.ts',
  'apps/web/src/db/schema/rls.ts',
  // The identity and plugin seams
  'apps/web/src/plugins/api/identity*',
  'apps/web/src/plugins/api/auth.ts',
  'apps/web/src/plugins/api/access.ts',
  'apps/web/src/plugins/api/secrets.ts',
  'apps/web/src/plugins/api/types.ts',
  'apps/web/src/plugins/types.ts',
  'packages/shared/src/plugins/types.ts',
  // AI tool binding and the agent loop
  'apps/web/src/api/services/agents/tools/**',
  'apps/web/src/api/services/agents/runtime.ts',
  'apps/web/src/api/services/ai/agent-loop.ts',
  'apps/web/src/api/services/ai/chat-turn.ts',
])

/** The changed paths a security audit should look at before the release, in input order. */
export function auditCadencePaths(changed, globs = AUDIT_CADENCE_GLOBS) {
  return (changed ?? []).filter(f => matchesAny(f, globs))
}

/** The warning `pnpm kit:release` prints for those paths, or [] when there are none. */
export function auditCadenceWarning(paths, previous) {
  if (paths.length === 0) return []
  const shown = paths.slice(0, 8).map(p => `    ${p}`)
  if (paths.length > shown.length) shown.push(`    … and ${paths.length - shown.length} more`)
  return [
    `⚠ WARNING: ${paths.length} change(s) since ${previous} touch auth, tenancy/RLS, the identity or`,
    '  plugin seams, or AI tool binding:',
    ...shown,
    `  Run a diff-scoped standard audit first: /rf-security standard ${previous}..HEAD`,
    '  (docs/SECURITY-AUDIT.md, "Cadence"). This is a reminder, not a gate.',
  ]
}

/** Paths changed between `ref` and HEAD, or null when git cannot say (no such tag, no git). */
function changedSince(ref, root) {
  try {
    return execFileSync('git', ['diff', '--name-only', `${ref}..HEAD`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the plugin matrix (#180)

export const MATRIX_WORKFLOW = 'plugin-matrix.yml'
export const MATRIX_WAIT_MINUTES = 10

/** `gh` (or `git`) as `{ status, stdout, stderr }`, never a throw: a missing binary is status -1. */
export function runTool(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) return { status: -1, stdout: '', stderr: r.error.message }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * Dispatch the plugin matrix against `main` as GitHub has it — the commit this release is cut
 * from — before the release is committed, so its ~10 minutes overlap the fold, the release check
 * and the gate. A warning, never a block: any failure (no `gh`, not logged in, no network, a
 * dispatch refused) returns `{ skipped }` with the reason, and the release goes on.
 *
 * `run` is the tool runner (`runTool` by default), injected so the tests drive it with a script.
 */
export function dispatchPluginMatrix({ version, root, run = runTool, now = Date.now }) {
  const gh = (...a) => run('gh', a, { cwd: root })
  if (gh('--version').status !== 0) return { skipped: 'gh is not installed' }
  const remote = run('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: root })
  const sha = remote.status === 0 ? remote.stdout.split(/\s/)[0] : ''
  if (!/^[0-9a-f]{40}$/.test(sha)) return { skipped: 'cannot read origin/main' }
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  const requestId = `release-${version}-${now()}`
  const dispatched = gh(
    'workflow',
    'run',
    MATRIX_WORKFLOW,
    '--ref',
    'main',
    '-f',
    `kit_ref=${sha}`,
    '-f',
    `request_id=${requestId}`
  )
  if (dispatched.status !== 0) {
    return {
      skipped: `gh workflow run failed: ${dispatched.stderr.trim().split('\n')[0] || 'no output'}`,
    }
  }
  return { requestId, sha, unpushed: head !== sha }
}

/** The dispatched run, found by the request id `plugin-matrix.yml` puts in its run name. */
function findMatrixRun(requestId, gh) {
  const list = gh(
    'run',
    'list',
    '--workflow',
    MATRIX_WORKFLOW,
    '--event',
    'workflow_dispatch',
    '--limit',
    '20',
    '--json',
    'databaseId,displayTitle,status,conclusion,url'
  )
  if (list.status !== 0) return null
  try {
    return JSON.parse(list.stdout).find(r => String(r.displayTitle).includes(requestId)) ?? null
  } catch {
    return null
  }
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Wait (up to `timeoutMs`) for the dispatched run and return the lines to print: `✔` per green
 * plugin job, `⚠ <plugin> fails on main: <step>, <run>` per red one, or one `⚠` line saying why
 * there is no verdict (still running, run not found, gh failing) with the URL to watch.
 */
export function awaitPluginMatrix(
  handle,
  { root, run = runTool, sleep = sleepSync, now = Date.now, timeoutMs, pollMs = 20_000 } = {}
) {
  if (handle.skipped) return [`⚠ plugin matrix not checked: ${handle.skipped}`]
  if (timeoutMs === 0) {
    return [
      `… plugin matrix not awaited (--matrix-wait 0): gh run list --workflow ${MATRIX_WORKFLOW}`,
    ]
  }
  const gh = (...a) => run('gh', a, { cwd: root })
  const deadline = now() + (timeoutMs ?? MATRIX_WAIT_MINUTES * 60_000)
  let found = null
  for (;;) {
    found = findMatrixRun(handle.requestId, gh) ?? found
    if (found?.status === 'completed' || now() >= deadline) break
    sleep(pollMs)
  }
  if (!found)
    return [
      `⚠ plugin matrix: dispatched, but its run was not found (gh run list --workflow ${MATRIX_WORKFLOW})`,
    ]
  if (found.status !== 'completed') {
    return [`⚠ plugin matrix still running: ${found.url} — gh run watch ${found.databaseId}`]
  }
  const view = gh('run', 'view', String(found.databaseId), '--json', 'jobs')
  let jobs = []
  try {
    jobs = JSON.parse(view.stdout).jobs ?? []
  } catch {}
  return pluginMatrixLines(jobVerdicts(jobs), found.url)
}

/** The verdict lines for one finished run. */
export function pluginMatrixLines(verdicts, url) {
  if (verdicts.length === 0) return [`⚠ plugin matrix ran no plugin job: ${url}`]
  const red = verdicts.filter(v => !v.ok)
  if (red.length === 0) {
    return [`✔ plugin matrix              ${verdicts.map(v => v.plugin).join(', ')} pass on main`]
  }
  return red.map(v => `⚠ ${v.plugin} fails on main: ${v.step ?? v.conclusion}, ${v.url ?? url}`)
}

/** `git ls-remote` as a boolean: does `ref` exist on that remote? The offline-ish fallback. */
function lsRemoteResolves(repo, ref, root = SCRIPT_ROOT) {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', repo, ref], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return true
  } catch {
    return false
  }
}

/** The blobless bare mirror `scripts/plugin.mjs` would use for the same repository. */
function openPluginMirror(repo, root = SCRIPT_ROOT) {
  return ensureMirror(repo, mirrorDirFor(repo, abs(root, PLUGIN_MIRROR_ROOT)), {
    cwd: root,
    warn: () => {},
  })
}

/**
 * Resolve one `defaultPlugins` entry: is it still fetchable at the ref the kit pins, and what
 * `minKit` floor does it declare? The I/O half of `defaultPluginProblems` (D31, decision 5).
 *
 * **The MIRROR is what answers the second half**, and it has to: `git ls-remote` proves a ref
 * exists but cannot read a file out of it, so before this the floor came only from an INSTALLED
 * surface — and the kit does not install its own default plugins. `pnpm kit:release 0.7.0` was
 * therefore refused every single time with "cannot read its declaration", making
 * `--skip-plugin-check` mandatory rather than the loud escape hatch it was written as, which is
 * the same as having no check at all.
 *
 * So: fetch the plugin at its pinned ref into the same blobless mirror `pnpm plugin` already keeps
 * (one clone, cached under `.upgrade/plugins/`), and read `rocketflare-plugin.json` out of it. That
 * is the plugin's own statement AT THE PIN, which is strictly better than an installed surface's
 * record of whatever was true when somebody last installed it.
 *
 * **`minKit` is read from the TOP LEVEL only**, exactly as `plugin-lib.mjs`'s `floorOf` and
 * `.github/workflows/plugin-ci.yml` read it. A manifest still carrying `requires.kit` is not
 * quietly treated as having no floor: the range is carried out as `legacyRange` so the caller can
 * name the field and its replacement. Reading a second spelling here would mean this and CI
 * disagreed about one manifest, which is the silent drift the whole change removes.
 *
 * Three fallbacks, each deliberate:
 *
 *   - the mirror cannot be opened (offline, no access) → `ls-remote` proves the ref, and the floor
 *     falls back to the installed surface, or to null, which the caller still reports;
 *   - the ref resolves but carries no manifest → the surface's record, rather than a refusal: an
 *     older plugin release may predate the file;
 *   - the manifest is there but is not JSON → a refusal, because that is a broken plugin rather
 *     than a missing answer.
 *
 * `openMirror` and `lsRemote` are injected so the test can drive every branch without a network.
 */
export function resolveDefaultPlugin(
  entry,
  { manifest = null, openMirror = openPluginMirror, lsRemote = lsRemoteResolves } = {}
) {
  const surface = (manifest?.surfaces ?? []).find(s => s.kind === 'plugin' && s.id === entry.id)
  const recorded = {
    minKit: surface?.minKit ?? null,
    legacyRange: surface?.requires?.kit ?? null,
    version: surface?.source?.version ?? null,
  }
  const missingRef = () => ({
    ok: false,
    reason: entry.ref
      ? `no '${entry.ref}' in that repository — release the plugin, or repin the ref`
      : 'the repository is unreachable',
  })

  let mirror = null
  try {
    mirror = openMirror(entry.repo)
  } catch {
    mirror = null
  }
  if (!mirror) {
    if (!lsRemote(entry.repo, entry.ref ?? 'HEAD')) return missingRef()
    return { ok: true, ...recorded }
  }

  const file = entry.subdir
    ? `${entry.subdir.replace(/\/+$/, '')}/${PLUGIN_MANIFEST_FILE}`
    : PLUGIN_MANIFEST_FILE
  // Either tag form (#181), as `plugin add` reads it: a pinned bare `X.Y.Z` is the plugin's own
  // `<id>-vX.Y.Z` when that exists, and no pin is the plugin's newest release of either form.
  const ref =
    mirror.releaseRef(entry.id, entry.ref) ??
    mirror.latestTagFor(entry.id, { manifest: file }) ??
    'HEAD'
  if (!mirror.resolves(ref)) return missingRef()
  const shown = mirror.tryShow(ref, file)
  if (!shown.ok) return { ok: true, ...recorded }
  try {
    const declared = JSON.parse(shown.out)
    return {
      ok: true,
      minKit: declared.minKit ?? recorded.minKit,
      legacyRange: declared.requires?.kit ?? recorded.legacyRange,
      version: declared.version ?? recorded.version,
    }
  } catch {
    return { ok: false, reason: `${file} at ${ref} is not valid JSON` }
  }
}

/**
 * The stop decision 5 asks for: do not cut `version` while a default plugin cannot be fetched at
 * its pin or declares a minKit floor above it. Returns a problem list; empty means go.
 */
function checkDefaultPlugins(version, root) {
  const { manifest } = readManifest(root)
  // The CI canaries too: a release whose CI plugin cannot install is one kit.yml goes red on.
  const entries = ciPluginEntries(manifest, readCiPlugins(root))
  if (entries.length === 0) return { entries, problems: [] }
  return {
    entries,
    problems: defaultPluginProblems(
      entries,
      version,
      entry =>
        resolveDefaultPlugin(entry, {
          manifest,
          openMirror: repo => openPluginMirror(repo, root),
          lsRemote: (repo, ref) => lsRemoteResolves(repo, ref, root),
        }),
      { kitRepo: manifest?.kit?.repo }
    ),
  }
}

/**
 * The first PARAGRAPH of "What changed", rewrapped onto one line — not the first LINE. Notes are
 * written to the repo's 100-column convention, so a summary sentence almost always spans several
 * physical lines and taking the first one truncates it mid-clause, in the file adopters read to
 * decide whether a release concerns them.
 */
function summaryOf(parsed) {
  return (
    (parsed.body.split('## What changed')[1] ?? '')
      .split(/\n## /)[0]
      .trim()
      .split(/\n\s*\n/)
      .map(block => block.trim())
      .find(block => block !== '')
      ?.split('\n')
      .map(line => line.trim())
      .join(' ') ?? 'See the porting note.'
  )
}

// ---------------------------------------------------------------- folding fragments

/** A list item's marker at column 0: `- `, `* `, `1. ` or `1) `. The number is ignored. */
const ITEM_MARKER = /^(?:\d+[.)]|[-*])\s+/
/** The one Verify step every change ends with, kept once, last. */
const GATE_STEP = /^`pnpm gate` passes\.?$/

/**
 * A section's list items. A line opening with a marker starts an item; every line until the next
 * marker (blank lines inside included) continues it, dedented by up to the marker's width so it
 * can be re-indented under a new number. Prose before any marker is one item. A fragment writes
 * its steps unnumbered; whatever numbers a step carries are dropped here.
 */
export function listItems(content) {
  const items = []
  let current = null
  let blanks = 0
  for (const line of (content ?? '').split('\n')) {
    const marker = line.match(ITEM_MARKER)
    if (marker) {
      current = { first: line.slice(marker[0].length), rest: [], width: marker[0].length }
      items.push(current)
      blanks = 0
    } else if (line.trim() === '') {
      if (current) blanks++
    } else if (!current) {
      current = { first: line.trim(), rest: [], width: 0 }
      items.push(current)
    } else {
      for (; blanks > 0; blanks--) current.rest.push('')
      const indent = line.length - line.trimStart().length
      current.rest.push(line.slice(Math.min(indent, current.width)))
    }
  }
  return items.map(({ first, rest }) => ({ first, rest }))
}

/** Items as a numbered list, each continuation indented under its own number. */
function numbered(items) {
  return items
    .map((item, i) => {
      const marker = `${i + 1}. `
      const pad = ' '.repeat(marker.length)
      return [marker + item.first, ...item.rest.map(l => (l === '' ? '' : pad + l))].join('\n')
    })
    .join('\n')
}

/** `[a, b]`, quoting an item a reader would split or misread. */
const inlineList = items =>
  `[${items.map(i => (/[,[\]"']/.test(i) ? JSON.stringify(i) : i)).join(', ')}]`

/** A block sequence for the human sentences `migrations` holds, or `[]`. */
const blockList = items =>
  items.length === 0 ? ' []' : `\n${items.map(i => `  - ${JSON.stringify(i)}`).join('\n')}`

const union = lists => [...new Set(lists.flat().filter(v => typeof v === 'string' && v !== ''))]

/**
 * Fold the pending parts of a release (the legacy `unreleased.md`, when it has entries, and every
 * fragment) into one porting note's text. A part is `{ name, text, legacy? }`.
 *
 * ORDER, the same in every section: a fragment's `order` first (`first`, then integers low to
 * high, absent = 0, then `last`), the legacy file ahead of fragments at the same rank, then
 * fragments by filename.
 *
 * FRONTMATTER: `breaking` and `manual` are true if any part's is; the four lists are unioned in
 * that order and de-duplicated; `version`, `previous` and `date` are the release's.
 *
 * BODY: "What changed" opens with every part's summary sentence in one paragraph (the CHANGELOG
 * line, so tighten it by hand when it runs long), then every part's bullets. "How to apply" and
 * "Verify" are renumbered from 1; Verify's "`pnpm gate` passes." is dropped from every part and
 * written once, last, when any part had it. "Conflicts to expect" concatenates, and is `None.`
 * only when every part says none.
 */
export function mergeNotes(parts, { version, previous, date }) {
  const parsed = parts
    .map((part, index) => {
      const note = parseNote(part.text)
      if (!note) throw new Error(`${part.name}: no YAML frontmatter`)
      const rank = part.legacy ? 0 : fragmentRank(note.data.order)
      if (rank === null) throw new Error(`${part.name}: order is '${note.data.order}'`)
      for (const heading of note.body.split('\n').filter(l => /^## /.test(l))) {
        if (!NOTE_HEADINGS.includes(heading)) {
          throw new Error(`${part.name}: '${heading}' is not one of the four headings`)
        }
      }
      return { ...part, ...note, rank, index }
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(Boolean(b.legacy)) - Number(Boolean(a.legacy)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index)
    )

  const summaries = []
  const changes = []
  const steps = []
  const conflicts = []
  const checks = []
  let gate = false
  for (const part of parsed) {
    // The summary is the opening paragraph: up to the first blank line or list item.
    const lines = (sectionOf(part.body, '## What changed') ?? '').split('\n')
    const cut = lines.findIndex(l => l.trim() === '' || ITEM_MARKER.test(l))
    const summary = (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim()
    const rest = cut === -1 ? '' : lines.slice(cut).join('\n').trim()
    if (summary) summaries.push(summary)
    if (rest) changes.push(rest)
    steps.push(...listItems(sectionOf(part.body, '## How to apply')))
    const conflict = sectionOf(part.body, '## Conflicts to expect') ?? ''
    if (conflict !== '' && !/^None\b/i.test(conflict)) conflicts.push(conflict)
    for (const item of listItems(sectionOf(part.body, '## Verify'))) {
      if (item.rest.length === 0 && GATE_STEP.test(item.first.trim())) gate = true
      else checks.push(item)
    }
  }
  if (gate) checks.push({ first: '`pnpm gate` passes.', rest: [] })

  const data = parsed.map(p => p.data)
  const list = key => union(data.map(d => (Array.isArray(d[key]) ? d[key] : [])))
  return [
    '---',
    `version: ${version}`,
    `previous: ${previous ?? 'null'}`,
    `date: ${date}`,
    `breaking: ${data.some(d => d.breaking === true)}`,
    `migrations:${blockList(list('migrations'))}`,
    `areas: ${inlineList(list('areas'))}`,
    `touches_surfaces: ${inlineList(list('touches_surfaces'))}`,
    `requires_surfaces: ${inlineList(list('requires_surfaces'))}`,
    `manual: ${data.some(d => d.manual === true)}`,
    '---',
    '',
    '## What changed',
    '',
    [summaries.join('\n'), changes.join('\n')].filter(Boolean).join('\n\n'),
    '',
    '## How to apply',
    '',
    numbered(steps),
    '',
    '## Conflicts to expect',
    '',
    conflicts.length > 0 ? conflicts.join('\n') : 'None.',
    '',
    '## Verify',
    '',
    numbered(checks),
    '',
  ].join('\n')
}

const freshUnreleased = version => `---
version: unreleased
previous: ${version}
date: null
breaking: false
migrations: []
areas: []
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

_Nothing yet. A change adds a fragment, \`unreleased/<slug>.md\` beside this file, rather than
editing this one: parallel pull requests then never conflict here (\`README.md\` beside this file
has the shape). \`pnpm kit:release\` folds both forms into the release note._

## How to apply

_Numbered, imperative, each step self-contained — no "these", "them" or "the above" reaching
outside its own step._

## Conflicts to expect

_One line each: \`path → what changed → what to do\`. Or exactly \`None.\`_

## Verify

_Numbered checkable commands and assertions only._
`

function main(argv) {
  const { root: repoRoot, rest, error } = resolveRepoRoot(argv)
  if (error) {
    warn(`error: ${error}`, '', USAGE)
    return 2
  }
  let version = null
  let date = new Date().toISOString().slice(0, 10)
  let dryRun = false
  let skipPluginCheck = false
  let matrix = true
  let matrixWait = MATRIX_WAIT_MINUTES
  const pluginDirs = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--date') date = rest[++i]
    else if (rest[i] === '--dry-run') dryRun = true
    else if (rest[i] === '--skip-plugin-check') skipPluginCheck = true
    else if (rest[i] === '--no-matrix') matrix = false
    else if (rest[i] === '--matrix-wait') {
      matrixWait = Number(rest[++i])
      if (!Number.isFinite(matrixWait) || matrixWait < 0) {
        warn(
          'error: --matrix-wait needs a number of minutes (0 = dispatch, do not wait)',
          '',
          USAGE
        )
        return 2
      }
    } else if (rest[i] === '--plugin') {
      // REPEATABLE rather than comma-separated, because the value is a PATH: splitting a
      // path-valued option on a comma invents an escaping rule for a character a path may legally
      // contain, and this flag is read by people typing it once per plugin anyway.
      const sub = rest[++i]
      if (!sub || sub.startsWith('-')) {
        warn('error: --plugin needs a subdirectory, e.g. --plugin plugins/analytics', '', USAGE)
        return 2
      }
      pluginDirs.push(sub.replace(/\/+$/, ''))
    } else if (rest[i] === '-h' || rest[i] === '--help') {
      out(USAGE)
      return 0
    } else if (!version) version = rest[i]
    else {
      warn(`error: unexpected argument '${rest[i]}'`, '', USAGE)
      return 2
    }
  }
  if (!version || !VERSION_RE.test(version)) {
    warn('error: a version like 0.2.0 is required', '', USAGE)
    return 2
  }
  if (new Set(pluginDirs).size !== pluginDirs.length) {
    warn('error: --plugin names the same subdirectory twice', '', USAGE)
    return 2
  }

  // With no `--plugin` this is exactly what it always was: one context, resolved at the root.
  const targets =
    pluginDirs.length === 0
      ? [{ subdir: '', ctx: releaseContext(repoRoot) }]
      : pluginDirs.map(subdir => ({
          subdir,
          ctx: releaseContext(path.join(repoRoot, subdir), { repoRoot }),
        }))

  for (const { subdir, ctx } of targets) {
    if (ctx.kind === 'app') {
      warn('error: this is an app, not the kit — `pnpm kit:release` cuts KIT releases.')
      return 1
    }
    if (ctx.kind === 'unknown') {
      if (subdir) {
        warn(
          `error: no ${PLUGIN_MANIFEST_FILE} in ${subdir} — --plugin names the directory that holds`,
          'one, e.g. --plugin plugins/analytics.'
        )
      } else {
        warn(
          `error: no ${MANIFEST_FILE} and no ${PLUGIN_MANIFEST_FILE} — this is neither the kit nor a`,
          'plugin repository, so there is nothing whose release this would be.',
          '',
          `If this is a plugin MONOREPO, name the plugin: --plugin plugins/<id>.`
        )
      }
      return 1
    }
    if (subdir && ctx.kind !== 'plugin') {
      warn(`error: ${subdir} is not a plugin — --plugin is only for a plugin repository.`)
      return 1
    }
  }
  const ctx = targets[0].ctx

  // A kit release ships a `defaultPlugins` set (what a fresh clone installs) and a CI set
  // (`.github/ci-plugins.json`, what kit.yml installs): a version one of them cannot be fetched at
  // its pin for — or that falls below a floor one declares — is a version that does not bootstrap,
  // or whose CI is red. What this can and cannot prove is written out on `defaultPluginProblems`;
  // the CI job is what proves them GREEN.
  if (ctx.kind === 'kit' && !skipPluginCheck) {
    const { entries, problems } = checkDefaultPlugins(version, repoRoot)
    if (problems.length > 0) {
      warn(
        `error: ${version} cannot be released — its default / CI plugins are not ready:`,
        ...problems.map(p => `  ${p}`),
        '',
        'Fix the pin (or the plugin), or pass --skip-plugin-check if you know why this is fine.'
      )
      return 1
    }
    if (entries.length > 0) {
      out(`✔ default + CI plugins       ${entries.map(e => e.id).join(', ')} resolve at ${version}`)
    }
  } else if (skipPluginCheck) {
    warn(
      '⚠ --skip-plugin-check: the default plugins were NOT checked against this version. A fresh',
      '  clone installs them, so if one of them does not support it, that breaks on somebody else.'
    )
  }

  // The plugin matrix against `main`, dispatched NOW so it runs while the release is folded,
  // checked and gated; its verdict is printed at the end. Kit only, never on a dry run, and a
  // warning whatever happens (`dispatchPluginMatrix`).
  const matrixRun =
    ctx.kind === 'kit' && matrix && !dryRun
      ? dispatchPluginMatrix({ version, root: repoRoot })
      : null
  if (matrixRun?.requestId) {
    out(
      `… plugin matrix dispatched against main ${matrixRun.sha.slice(0, 12)} (${matrixRun.requestId})`
    )
    if (matrixRun.unpushed) {
      warn(
        '  note: HEAD is not origin/main — the matrix proves main as pushed, not your local commits.'
      )
    }
  }

  // One JOB per plugin being released. In the kit and in a single-plugin repository there is
  // exactly one, and everything below reads the same as it always did.
  const jobs = []
  for (const { ctx: target } of targets) {
    const notePath = `${target.notesDir}/${version}.md`
    if (existsSync(abs(repoRoot, notePath))) {
      warn(`error: ${notePath} already exists`)
      return 1
    }
    const unreleasedPath = `${target.notesDir}/unreleased.md`
    const fragments = listFragments(target.notesDir, { root: repoRoot })
    const hasLegacy = existsSync(abs(repoRoot, unreleasedPath))
    if (!hasLegacy && fragments.length === 0) {
      warn(`error: ${unreleasedPath} does not exist`)
      return 1
    }
    const unreleased = hasLegacy ? read(repoRoot, unreleasedPath) : null
    if (unreleased !== null && !parseNote(unreleased)) {
      warn(`error: ${unreleasedPath} has no frontmatter`)
      return 1
    }
    // A fragment is checked by `release-check --unreleased` in its own pull request; checked again
    // here, because a fragment that slipped past it would be folded into a note that cannot change.
    const checkOptions = fragmentCheckOptions(repoRoot)
    const fragmentErrors = fragments.flatMap(f =>
      fragmentProblems(f.text, { ...checkOptions, file: f.file })
    )
    if (fragmentErrors.length > 0) {
      warn('error: fix these fragments first:', ...fragmentErrors.map(p => `  ${p}`))
      return 1
    }
    const legacyHasEntries = unreleased !== null && !/_Nothing yet\./.test(unreleased)
    if (!legacyHasEntries && fragments.length === 0) {
      warn(
        `error: ${unreleasedPath} is empty and ${fragmentsDir(target.notesDir)}/ has no fragment —`,
        'a release with nothing to port is a gap every adopter has to step over. Write what changed',
        'first (docs/upgrades/README.md).'
      )
      return 1
    }
    const notes = releaseNotes(target.notesDir, { root: repoRoot })
    const previous = notes.length > 0 ? notes[notes.length - 1].version : null
    // No fragment: the legacy file IS the note, byte for byte, as it always was.
    const note =
      fragments.length === 0
        ? unreleased
            .replace(/^version: .*$/m, `version: ${version}`)
            .replace(/^previous: .*$/m, `previous: ${previous ?? 'null'}`)
            .replace(/^date: .*$/m, `date: ${date}`)
        : mergeNotes(
            [
              ...(legacyHasEntries
                ? [{ name: 'unreleased.md', text: unreleased, legacy: true }]
                : []),
              ...fragments.map(f => ({ name: f.name, text: f.text })),
            ],
            { version, previous, date }
          )
    // Released anyway — a guide, not a gate — but said, so the next one is cut sooner.
    const tooLong = noteLengthWarning(note, notePath)
    if (tooLong) out(tooLong)
    const folded = fragments.length + (legacyHasEntries ? 1 : 0)
    if (folded > 1) {
      out(
        `note: ${notePath} opens "What changed" with ${folded} summary sentences, one per part —`,
        '  CHANGELOG.md lifts that paragraph verbatim, so tighten it in both before you commit.'
      )
    }
    jobs.push({
      id: target.id ?? null,
      notePath,
      unreleasedPath,
      legacyHasEntries,
      fragments: fragments.map(f => f.file),
      previous,
      summary: summaryOf(parseNote(note)),
      note,
    })
  }

  // A reminder, not a gate: the audit costs model budget and needs Docker, so it is never forced.
  if (ctx.kind === 'kit' && jobs[0]?.previous) {
    const changed = changedSince(jobs[0].previous, repoRoot)
    if (changed) warn(...auditCadenceWarning(auditCadencePaths(changed), jobs[0].previous))
  }

  const changelog = existsSync(abs(repoRoot, ctx.changelog))
    ? read(repoRoot, ctx.changelog)
    : '# Changelog\n'
  const nextChangelog = prependChangelogSection(
    changelog,
    changelogSection(
      version,
      date,
      jobs.map(j => ({ id: j.id, summary: j.summary, note: j.notePath }))
    )
  )

  // Patch each version in place rather than re-serialising the JSON: `JSON.stringify` loses the
  // formatting Biome wants (short arrays on one line), so a re-serialised file fails the repo's own
  // `pnpm lint` and the release cannot produce a commit that passes the gate. Same byte-preserving
  // discipline as `scripts/provision/patch-toml.ts`.
  //
  // The list is deduplicated across targets because a monorepo's contexts each name EVERY manifest
  // in the repository — releasing two plugins must stamp each file once, not twice.
  const versionFiles = []
  const seen = new Set()
  for (const { ctx: target } of targets) {
    for (const vf of target.versionFiles) {
      if (seen.has(vf.file)) continue
      seen.add(vf.file)
      versionFiles.push(vf)
    }
  }
  const stamped = []
  for (const { file, pattern, label } of versionFiles) {
    if (!existsSync(abs(repoRoot, file))) continue
    const text = read(repoRoot, file)
    const next = text.replace(pattern, `$1"${version}"`)
    if (next === text) {
      warn(`error: could not find the version to stamp in ${file}`)
      return 1
    }
    stamped.push({ file, text: next, label })
  }
  if (stamped.length === 0) {
    warn(`error: none of ${versionFiles.map(v => v.file).join(', ')} exists`)
    return 1
  }

  // The column is as wide as the widest path, floored at 32 so the kit's own output is byte for
  // byte what it always was (its longest path, `docs/upgrades/unreleased.md`, is 27). A monorepo's
  // `plugins/<id>/docs/upgrades/<version>.md` is far longer, and a fixed 32 ran the two columns
  // together into one unreadable word.
  const width = Math.max(
    32,
    1 +
      Math.max(
        ...jobs.flatMap(j => [j.notePath.length, j.unreleasedPath.length]),
        ...jobs.flatMap(j => j.fragments.map(f => f.length))
      ),
    1 + ctx.changelog.length,
    1 + Math.max(...stamped.map(s => s.file.length))
  )
  const pad = value => value.padEnd(width)
  // With no fragment the lines read exactly as they always did.
  const source = j => {
    if (j.fragments.length === 0) return 'unreleased.md'
    const frags = `${j.fragments.length} fragment(s)`
    return j.legacyHasEntries ? `unreleased.md + ${frags}` : frags
  }

  if (dryRun) {
    out(
      `dry run — would write:`,
      ...jobs.flatMap(j => [
        `  ${pad(j.notePath)}from ${source(j)} (previous: ${j.previous ?? 'null'})`,
        `  ${pad(j.unreleasedPath)}reset`,
        ...j.fragments.map(f => `  ${pad(f)}folded, deleted`),
      ]),
      `  ${pad(ctx.changelog)}new '## ${version}' section`,
      ...stamped.map(s => `  ${pad(s.file)}${s.label} ${version}`)
    )
    return 0
  }

  for (const j of jobs) {
    writeFileSync(abs(repoRoot, j.notePath), j.note)
    writeFileSync(abs(repoRoot, j.unreleasedPath), freshUnreleased(version))
    for (const f of j.fragments) rmSync(abs(repoRoot, f))
  }
  writeFileSync(abs(repoRoot, ctx.changelog), nextChangelog)
  for (const s of stamped) writeFileSync(abs(repoRoot, s.file), s.text)

  out(
    ...jobs.flatMap(j => [
      `✔ ${pad(j.notePath)}folded from ${source(j)} (previous: ${j.previous ?? 'null'})`,
      `✔ ${pad(j.unreleasedPath)}reset`,
      ...j.fragments.map(f => `✔ ${pad(f)}folded, deleted`),
    ]),
    `✔ ${pad(ctx.changelog)}'## ${version}' prepended`,
    ...stamped.map(s => `✔ ${pad(s.file)}${s.label} ${version}`),
    '',
    'Verify:',
    `  node scripts/release-check.mjs --tag ${version}`,
    `  pnpm gate`,
    '',
    // `-a` stages tracked files only: without the `git add`, the new note was left out of the tag.
    `Then: git add ${jobs.map(j => j.notePath).join(' ')} && git commit -am "Release ${version}" && git tag -m "Release ${version}" ${version} && git push origin main ${version}`,
    // The site mirrors the kit's notes as committed data and nothing triggers it (CONTRIBUTING.md).
    ...(ctx.kind === 'kit'
      ? [
          `And:  rocketflare-www — on a branch, \`npm run sync:releases\`, write the ${version} summary,`,
          '      `npm run check:releases && npm run build`, open a PR (merging deploys rocketflare.dev)',
        ]
      : [])
  )
  if (matrixRun) {
    out('')
    if (matrixRun.requestId && matrixWait > 0) {
      out(
        `waiting up to ${matrixWait} min for the plugin matrix (the files above are written; Ctrl-C is safe) …`
      )
    }
    const lines = awaitPluginMatrix(matrixRun, { root: repoRoot, timeoutMs: matrixWait * 60_000 })
    for (const line of lines) (line.startsWith('⚠') ? warn : out)(line)
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    warn(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
