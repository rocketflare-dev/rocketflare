#!/usr/bin/env node
/**
 * Cut a release — the mechanical half, so `scripts/release-check.mjs` passes by construction.
 *
 *   node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run] [--skip-plugin-check]
 *
 * Folds `docs/upgrades/unreleased.md` into `docs/upgrades/X.Y.Z.md`, fills its `version`,
 * `previous` and `date`, bumps every version file, prepends a `CHANGELOG.md` section, and writes a
 * fresh empty `unreleased.md`.
 *
 * Then: commit, `git tag X.Y.Z && git push origin X.Y.Z` (docs/DEPLOY.md, "The release dance").
 *
 * **Two kinds of repository run this** (D31). The kit stamps the root `package.json` and
 * `.rocketflare.json`'s `kit.version`; a PLUGIN repository — a checkout with a
 * `rocketflare-plugin.json` and no `.rocketflare.json` — stamps that manifest's `version` and its
 * `package.json` if it has one. Everything else is identical, because a plugin's releases are read
 * by exactly the same machinery: `previous` chains, the four headings, and `pnpm plugin upgrade`
 * walking the notes between two commits. `releaseContext()` is the whole of the difference.
 *
 * In the KIT it additionally refuses a version its `defaultPlugins` are not ready for (D31,
 * decision 5): every entry must still resolve at the ref the kit pins, and a declared
 * `requires.kit` range must admit the version being cut. `--skip-plugin-check` is the escape
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
  defaultPluginEntries,
  defaultPluginProblems,
  isKitManifest,
  parseNote,
  VERSION_RE,
} from './lib/upgrade-lib.mjs'
import { releaseNotes } from './release-check.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const abs = p => path.join(REPO_ROOT, p)
const read = p => readFileSync(abs(p), 'utf8')
const out = (...lines) => {
  for (const l of lines) process.stdout.write(`${l}\n`)
}
const warn = (...lines) => {
  for (const l of lines) process.stderr.write(`${l}\n`)
}

export const USAGE =
  'usage: node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run] [--skip-plugin-check]'

/** Match `"version": "x"` at the top level of a JSON file (two-space indent, so exactly one). */
const TOP_LEVEL_VERSION = /^( {2}"version":\s*)"[^"]+"/m

/**
 * Which repository is this, and what does a release stamp here?
 *
 * `kit` — `.rocketflare.json` with no `app` block. `app` — somebody's product, whose release
 * discipline is its own. `plugin` — a `rocketflare-plugin.json` at the root (D31), which is the
 * whole of what makes a repository a plugin.
 */
export function releaseContext(root = REPO_ROOT) {
  const at = p => path.join(root, p)
  if (existsSync(at(MANIFEST_FILE))) {
    const manifest = JSON.parse(readFileSync(at(MANIFEST_FILE), 'utf8'))
    if (!isKitManifest(manifest)) return { kind: 'app' }
    return {
      kind: 'kit',
      notesDir: 'docs/upgrades',
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
    return {
      kind: 'plugin',
      notesDir: 'docs/upgrades',
      changelog: 'CHANGELOG.md',
      versionFiles: [
        { file: PLUGIN_MANIFEST_FILE, pattern: TOP_LEVEL_VERSION, label: 'version' },
        { file: 'package.json', pattern: TOP_LEVEL_VERSION, label: 'version' },
      ],
    }
  }
  return { kind: 'unknown' }
}

/** `git ls-remote` as a boolean: does `ref` exist on that remote? The offline-ish fallback. */
function lsRemoteResolves(repo, ref) {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', repo, ref], {
      cwd: REPO_ROOT,
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
function openPluginMirror(repo) {
  return ensureMirror(repo, mirrorDirFor(repo, abs(PLUGIN_MIRROR_ROOT)), {
    cwd: REPO_ROOT,
    warn: () => {},
  })
}

/**
 * Resolve one `defaultPlugins` entry: is it still fetchable at the ref the kit pins, and what
 * `requires.kit` range does it declare? The I/O half of `defaultPluginProblems` (D31, decision 5).
 *
 * **The MIRROR is what answers the second half**, and it has to: `git ls-remote` proves a ref
 * exists but cannot read a file out of it, so before this the range came only from an INSTALLED
 * surface — and the kit does not install its own default plugins. `pnpm kit:release 0.7.0` was
 * therefore refused every single time with "cannot read its requires.kit range", making
 * `--skip-plugin-check` mandatory rather than the loud escape hatch it was written as, which is
 * the same as having no check at all.
 *
 * So: fetch the plugin at its pinned ref into the same blobless mirror `pnpm plugin` already keeps
 * (one clone, cached under `.upgrade/plugins/`), and read `rocketflare-plugin.json` out of it. That
 * is the plugin's own statement AT THE PIN, which is strictly better than an installed surface's
 * record of whatever was true when somebody last installed it.
 *
 * Three fallbacks, each deliberate:
 *
 *   - the mirror cannot be opened (offline, no access) → `ls-remote` proves the ref, and the range
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
    requiresKit: surface?.requires?.kit ?? null,
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
      requiresKit: declared.requires?.kit ?? recorded.requiresKit,
      version: declared.version ?? recorded.version,
    }
  } catch {
    return { ok: false, reason: `${file} at ${ref} is not valid JSON` }
  }
}

/**
 * The stop decision 5 asks for: do not cut `version` while a default plugin cannot be fetched at
 * its pin or declares a kit range that excludes it. Returns a problem list; empty means go.
 */
function checkDefaultPlugins(version) {
  const { manifest } = readManifest(REPO_ROOT)
  const entries = defaultPluginEntries(manifest)
  if (entries.length === 0) return { entries, problems: [] }
  return {
    entries,
    problems: defaultPluginProblems(
      entries,
      version,
      entry => resolveDefaultPlugin(entry, { manifest }),
      { kitRepo: manifest?.kit?.repo }
    ),
  }
}

function main(argv) {
  let version = null
  let date = new Date().toISOString().slice(0, 10)
  let dryRun = false
  let skipPluginCheck = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i]
    else if (argv[i] === '--dry-run') dryRun = true
    else if (argv[i] === '--skip-plugin-check') skipPluginCheck = true
    else if (argv[i] === '-h' || argv[i] === '--help') {
      out(USAGE)
      return 0
    } else if (!version) version = argv[i]
    else {
      warn(`error: unexpected argument '${argv[i]}'`, '', USAGE)
      return 2
    }
  }
  if (!version || !VERSION_RE.test(version)) {
    warn('error: a version like 0.2.0 is required', '', USAGE)
    return 2
  }
  const ctx = releaseContext()
  if (ctx.kind === 'app') {
    warn('error: this is an app, not the kit — `pnpm kit:release` cuts KIT releases.')
    return 1
  }
  if (ctx.kind === 'unknown') {
    warn(
      `error: no ${MANIFEST_FILE} and no ${PLUGIN_MANIFEST_FILE} — this is neither the kit nor a`,
      'plugin repository, so there is nothing whose release this would be.'
    )
    return 1
  }
  if (existsSync(abs(`${ctx.notesDir}/${version}.md`))) {
    warn(`error: ${ctx.notesDir}/${version}.md already exists`)
    return 1
  }

  // A kit release ships a `defaultPlugins` set with it: a fresh clone installs those plugins, so a
  // version whose default plugins cannot be fetched at their pin — or that falls outside a range
  // one of them declares — is a version that does not bootstrap. What this can and cannot prove is
  // written out on `defaultPluginProblems`; the CI job is what proves them GREEN.
  if (ctx.kind === 'kit' && !skipPluginCheck) {
    const { entries, problems } = checkDefaultPlugins(version)
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

  const notes = releaseNotes(ctx.notesDir)
  const previous = notes.length > 0 ? notes[notes.length - 1].version : null

  const unreleasedPath = `${ctx.notesDir}/unreleased.md`
  const unreleased = read(unreleasedPath)
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

  const note = unreleased
    .replace(/^version: .*$/m, `version: ${version}`)
    .replace(/^previous: .*$/m, `previous: ${previous ?? 'null'}`)
    .replace(/^date: .*$/m, `date: ${date}`)

  // The first PARAGRAPH of "What changed", rewrapped onto one line — not the first LINE. Notes are
  // written to the repo's 100-column convention, so a summary sentence almost always spans several
  // physical lines and taking the first one truncates it mid-clause, in the file adopters read to
  // decide whether a release concerns them.
  const summary =
    (parsed.body.split('## What changed')[1] ?? '')
      .split(/\n## /)[0]
      .trim()
      .split(/\n\s*\n/)
      .map(block => block.trim())
      .find(block => block !== '')
      ?.split('\n')
      .map(line => line.trim())
      .join(' ') ?? 'See the porting note.'

  const changelog = existsSync(abs(ctx.changelog)) ? read(ctx.changelog) : '# Changelog\n'
  const marker = '\n## '
  const at = changelog.indexOf(marker)
  const section = `## ${version} — ${date}\n\n${summary}\n[Porting note](${ctx.notesDir}/${version}.md).\n\n`
  const nextChangelog =
    at === -1
      ? `${changelog}\n${section}`
      : changelog.slice(0, at + 1) + section + changelog.slice(at + 1)

  // Patch each version in place rather than re-serialising the JSON: `JSON.stringify` loses the
  // formatting Biome wants (short arrays on one line), so a re-serialised file fails the repo's own
  // `pnpm lint` and the release cannot produce a commit that passes the gate. Same byte-preserving
  // discipline as `scripts/provision/patch-toml.ts`.
  const stamped = []
  for (const { file, pattern, label } of ctx.versionFiles) {
    if (!existsSync(abs(file))) continue
    const text = read(file)
    const next = text.replace(pattern, `$1"${version}"`)
    if (next === text) {
      warn(`error: could not find the version to stamp in ${file}`)
      return 1
    }
    stamped.push({ file, text: next, label })
  }
  if (stamped.length === 0) {
    warn(`error: none of ${ctx.versionFiles.map(v => v.file).join(', ')} exists`)
    return 1
  }

  const freshUnreleased = `---
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

_Nothing yet. Add an entry here in the same pull request as the change — see \`README.md\` beside this
file for the fields and for what "How to apply" has to say._

## How to apply

## Conflicts to expect

## Verify
`

  if (dryRun) {
    out(
      `dry run — would write:`,
      `  ${`${ctx.notesDir}/${version}.md`.padEnd(32)}from unreleased.md (previous: ${previous ?? 'null'})`,
      `  ${unreleasedPath.padEnd(32)}reset`,
      `  ${ctx.changelog.padEnd(32)}new '## ${version}' section`,
      ...stamped.map(s => `  ${s.file.padEnd(32)}${s.label} ${version}`)
    )
    return 0
  }

  writeFileSync(abs(`${ctx.notesDir}/${version}.md`), note)
  writeFileSync(abs(unreleasedPath), freshUnreleased)
  writeFileSync(abs(ctx.changelog), nextChangelog)
  for (const s of stamped) writeFileSync(abs(s.file), s.text)

  out(
    `✔ ${`${ctx.notesDir}/${version}.md`.padEnd(32)}folded from unreleased.md (previous: ${previous ?? 'null'})`,
    `✔ ${unreleasedPath.padEnd(32)}reset`,
    `✔ ${ctx.changelog.padEnd(32)}'## ${version}' prepended`,
    ...stamped.map(s => `✔ ${s.file.padEnd(32)}${s.label} ${version}`),
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
