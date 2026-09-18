#!/usr/bin/env node
/**
 * Cut a release — the mechanical half, so `scripts/release-check.mjs` passes by construction.
 *
 *   node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run] [--skip-plugin-check]
 *
 * WHICH repository it releases is `resolveRepoRoot` (`release-check.mjs`): `--repo-root <path>`,
 * else the git toplevel of the working directory, else the directory this script lives in.
 *
 * Folds `docs/upgrades/unreleased.md` into `docs/upgrades/X.Y.Z.md`, fills its `version`,
 * `previous` and `date`, bumps every version file, prepends a `CHANGELOG.md` section, and writes a
 * fresh empty `unreleased.md`.
 *
 * Then: commit, `git tag X.Y.Z && git push origin X.Y.Z` (docs/DEPLOY.md, "The release dance").
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
 * which cannot resolve a bare SHA, and `latestTag()` is how `--to` and `openSource` default. The
 * accepted cost of that lockstep: a fix to one plugin bumps every plugin's version.
 *
 * In the KIT it additionally refuses a version its `defaultPlugins` are not ready for (D31,
 * decision 5): every entry must still resolve at the ref the kit pins, and the version being cut
 * must be at or above the `minKit` floor that entry declares. `--skip-plugin-check` is the escape
 * hatch, and it says so loudly.
 *
 * Exit 0 ok · 1 error · 2 usage.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureMirror, mirrorDirFor, PLUGIN_MIRROR_ROOT } from './lib/git-lib.mjs'
import { MANIFEST_FILE, readManifest } from './lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from './lib/plugin-lib.mjs'
import {
  changelogSection,
  defaultPluginEntries,
  defaultPluginProblems,
  isKitManifest,
  parseNote,
  prependChangelogSection,
  VERSION_RE,
} from './lib/upgrade-lib.mjs'
import { findPluginManifests, releaseNotes, resolveRepoRoot } from './release-check.mjs'

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

  const ref = entry.ref ?? mirror.latestTag() ?? 'HEAD'
  if (!mirror.resolves(ref)) return missingRef()
  const file = entry.subdir
    ? `${entry.subdir.replace(/\/+$/, '')}/${PLUGIN_MANIFEST_FILE}`
    : PLUGIN_MANIFEST_FILE
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
  const entries = defaultPluginEntries(manifest)
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

_Nothing yet. Add an entry here in the same pull request as the change. This first paragraph is
lifted VERBATIM into \`CHANGELOG.md\`, so make it ONE standalone summary sentence of ≤ 40 words —
then one bullet per change, one line each, and no \`###\` sub-headings. Rationale belongs in
\`docs/CONCEPTS.md\` and is linked, never restated; see \`README.md\` beside this file._

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
  const pluginDirs = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--date') date = rest[++i]
    else if (rest[i] === '--dry-run') dryRun = true
    else if (rest[i] === '--skip-plugin-check') skipPluginCheck = true
    else if (rest[i] === '--plugin') {
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

  // A kit release ships a `defaultPlugins` set with it: a fresh clone installs those plugins, so a
  // version whose default plugins cannot be fetched at their pin — or that falls below a floor
  // one of them declares — is a version that does not bootstrap. What this can and cannot prove is
  // written out on `defaultPluginProblems`; the CI job is what proves them GREEN.
  if (ctx.kind === 'kit' && !skipPluginCheck) {
    const { entries, problems } = checkDefaultPlugins(version, repoRoot)
    if (problems.length > 0) {
      warn(
        `error: ${version} cannot be released — its default plugins are not ready:`,
        ...problems.map(p => `  ${p}`),
        '',
        'Fix the pin (or the plugin), or pass --skip-plugin-check if you know why this is fine.'
      )
      return 1
    }
    if (entries.length > 0) {
      out(`✔ default plugins            ${entries.map(e => e.id).join(', ')} resolve at ${version}`)
    }
  } else if (skipPluginCheck) {
    warn(
      '⚠ --skip-plugin-check: the default plugins were NOT checked against this version. A fresh',
      '  clone installs them, so if one of them does not support it, that breaks on somebody else.'
    )
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
    if (!existsSync(abs(repoRoot, unreleasedPath))) {
      warn(`error: ${unreleasedPath} does not exist`)
      return 1
    }
    const unreleased = read(repoRoot, unreleasedPath)
    const parsed = parseNote(unreleased)
    if (!parsed) {
      warn(`error: ${unreleasedPath} has no frontmatter`)
      return 1
    }
    if (/_Nothing yet\./.test(unreleased)) {
      warn(
        `error: ${unreleasedPath} is empty — a release with nothing to port is a gap every adopter`,
        'has to step over. Write what changed first (docs/upgrades/README.md).'
      )
      return 1
    }
    const notes = releaseNotes(target.notesDir, { root: repoRoot })
    const previous = notes.length > 0 ? notes[notes.length - 1].version : null
    jobs.push({
      id: target.id ?? null,
      notePath,
      unreleasedPath,
      previous,
      summary: summaryOf(parsed),
      note: unreleased
        .replace(/^version: .*$/m, `version: ${version}`)
        .replace(/^previous: .*$/m, `previous: ${previous ?? 'null'}`)
        .replace(/^date: .*$/m, `date: ${date}`),
    })
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
    1 + Math.max(...jobs.flatMap(j => [j.notePath.length, j.unreleasedPath.length])),
    1 + ctx.changelog.length,
    1 + Math.max(...stamped.map(s => s.file.length))
  )
  const pad = value => value.padEnd(width)

  if (dryRun) {
    out(
      `dry run — would write:`,
      ...jobs.flatMap(j => [
        `  ${pad(j.notePath)}from unreleased.md (previous: ${j.previous ?? 'null'})`,
        `  ${pad(j.unreleasedPath)}reset`,
      ]),
      `  ${pad(ctx.changelog)}new '## ${version}' section`,
      ...stamped.map(s => `  ${pad(s.file)}${s.label} ${version}`)
    )
    return 0
  }

  for (const j of jobs) {
    writeFileSync(abs(repoRoot, j.notePath), j.note)
    writeFileSync(abs(repoRoot, j.unreleasedPath), freshUnreleased(version))
  }
  writeFileSync(abs(repoRoot, ctx.changelog), nextChangelog)
  for (const s of stamped) writeFileSync(abs(repoRoot, s.file), s.text)

  out(
    ...jobs.flatMap(j => [
      `✔ ${pad(j.notePath)}folded from unreleased.md (previous: ${j.previous ?? 'null'})`,
      `✔ ${pad(j.unreleasedPath)}reset`,
    ]),
    `✔ ${pad(ctx.changelog)}'## ${version}' prepended`,
    ...stamped.map(s => `✔ ${pad(s.file)}${s.label} ${version}`),
    '',
    'Verify:',
    `  node scripts/release-check.mjs --tag ${version}`,
    `  pnpm lint && pnpm typecheck && pnpm test && pnpm build`,
    '',
    `Then: git commit -am "Release ${version}" && git tag ${version} && git push origin ${version}`
  )
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
