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
import {
  compareVersions,
  isDeployable,
  isKitManifest,
  NOTE_HEADINGS,
  parseNote,
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

function checkNote(note, problems, { expectPrevious } = {}) {
  const parsed = parseNote(read(note.file))
  if (!parsed) {
    problems.push(`${note.file}: no YAML frontmatter`)
    return
  }
  const { data, body } = parsed
  if (data.version !== note.version) {
    problems.push(
      `${note.file}: frontmatter version is '${data.version}', the filename says '${note.version}'`
    )
  }
  if (expectPrevious !== undefined && (data.previous ?? 'null') !== expectPrevious) {
    problems.push(
      `${note.file}: previous is '${data.previous}', expected '${expectPrevious}' — the chain /rf-upgrade walks must be unbroken`
    )
  }
  for (const key of ['breaking', 'manual']) {
    if (typeof data[key] !== 'boolean') problems.push(`${note.file}: ${key} must be true or false`)
  }
  for (const key of ['migrations', 'areas', 'touches_surfaces', 'requires_surfaces']) {
    if (!Array.isArray(data[key])) problems.push(`${note.file}: ${key} must be a list`)
  }
  for (const m of data.migrations ?? []) {
    if (/\.sql$|^\d{4}_/.test(m)) {
      problems.push(
        `${note.file}: migrations names a file ('${m}') — describe the change; an adopter regenerates their own`
      )
    }
  }
  const manifest = JSON.parse(read(MANIFEST_FILE))
  const ids = new Set(manifest.surfaces.map(s => s.id))
  for (const key of ['touches_surfaces', 'requires_surfaces']) {
    for (const id of data[key] ?? []) {
      if (!ids.has(id))
        problems.push(
          `${note.file}: ${key} names '${id}', which is not a surface in ${MANIFEST_FILE}`
        )
    }
  }
  let cursor = -1
  for (const heading of NOTE_HEADINGS) {
    const at = body.indexOf(`\n${heading}`)
    if (at === -1) problems.push(`${note.file}: missing the '${heading}' heading`)
    else if (at < cursor) problems.push(`${note.file}: '${heading}' is out of order`)
    else cursor = at
  }
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
  if (!changelog.includes(`## ${tag}`)) problems.push(`CHANGELOG.md has no '## ${tag}' section`)
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

const WATCHED = /^(apps|packages)\//
const EXEMPT = /(^|\/)(tests?|__tests__)\/|\.test\.(ts|tsx)$|\.md$/

function checkUnreleased(base, problems) {
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
  const behaviour = changed.filter(f => WATCHED.test(f) && !EXEMPT.test(f))
  if (behaviour.length === 0) {
    out('release-check: no behaviour change in apps/ or packages/ — nothing to record')
    return
  }
  if (!changed.includes('docs/upgrades/unreleased.md')) {
    problems.push(
      `${behaviour.length} file(s) under apps/ or packages/ changed without an entry in docs/upgrades/unreleased.md.`,
      'An adopter ports this change by reading that note; without it the change is invisible to every copy.',
      `First few: ${behaviour.slice(0, 5).join(', ')}`
    )
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
  if (!existsSync(path.join(REPO_ROOT, MANIFEST_FILE))) {
    out(`release-check: no ${MANIFEST_FILE} — nothing to check`)
    return 0
  }
  if (!isKitManifest(JSON.parse(read(MANIFEST_FILE)))) {
    out('release-check: this is an app, not the kit — skipped')
    return 0
  }

  const problems = []
  if (mode === 'tag') {
    if (!tag) {
      warn('error: --tag needs a version', '', USAGE)
      return 2
    }
    checkTag(tag, problems)
  } else {
    checkUnreleased(base, problems)
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
