#!/usr/bin/env node
/**
 * Cut a kit release — the mechanical half, so `scripts/release-check.mjs` passes by construction.
 *
 *   node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run]
 *
 * Folds `docs/upgrades/unreleased.md` into `docs/upgrades/X.Y.Z.md`, fills its `version`,
 * `previous` and `date`, bumps the root `package.json` and `.rocketflare.json` `kit.version`,
 * prepends a `CHANGELOG.md` section, and writes a fresh empty `unreleased.md`.
 *
 * Then: commit, `git tag X.Y.Z && git push origin X.Y.Z` (docs/DEPLOY.md, "The release dance").
 *
 * Exit 0 ok · 1 error · 2 usage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKitManifest, parseNote, VERSION_RE } from './lib/upgrade-lib.mjs'
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

export const USAGE = 'usage: node scripts/release.mjs <X.Y.Z> [--date YYYY-MM-DD] [--dry-run]'

function main(argv) {
  let version = null
  let date = new Date().toISOString().slice(0, 10)
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i]
    else if (argv[i] === '--dry-run') dryRun = true
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
  const manifest = JSON.parse(read('.rocketflare.json'))
  if (!isKitManifest(manifest)) {
    warn('error: this is an app, not the kit — `pnpm kit:release` cuts KIT releases.')
    return 1
  }
  if (existsSync(abs(`docs/upgrades/${version}.md`))) {
    warn(`error: docs/upgrades/${version}.md already exists`)
    return 1
  }

  const notes = releaseNotes()
  const previous = notes.length > 0 ? notes[notes.length - 1].version : null

  const unreleasedPath = 'docs/upgrades/unreleased.md'
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

  const summary =
    (parsed.body.split('## What changed')[1] ?? '')
      .split('##')[0]
      .trim()
      .split('\n')
      .find(l => l.trim() !== '') ?? 'See the porting note.'

  const changelog = read('CHANGELOG.md')
  const marker = '\n## '
  const at = changelog.indexOf(marker)
  const section = `## ${version} — ${date}\n\n${summary}\n[Porting note](docs/upgrades/${version}.md).\n\n`
  const nextChangelog =
    at === -1
      ? `${changelog}\n${section}`
      : changelog.slice(0, at + 1) + section + changelog.slice(at + 1)

  const pkg = read('package.json')
  const nextPkg = pkg.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${version}"`)
  manifest.kit.version = version

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
      `  docs/upgrades/${version}.md      (from unreleased.md, previous: ${previous ?? 'null'})`,
      `  docs/upgrades/unreleased.md     reset`,
      `  CHANGELOG.md                    new '## ${version}' section`,
      `  package.json                    version ${version}`,
      `  .rocketflare.json               kit.version ${version}`
    )
    return 0
  }

  writeFileSync(abs(`docs/upgrades/${version}.md`), note)
  writeFileSync(abs(unreleasedPath), freshUnreleased)
  writeFileSync(abs('CHANGELOG.md'), nextChangelog)
  writeFileSync(abs('package.json'), nextPkg)
  writeFileSync(abs('.rocketflare.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  out(
    `✔ docs/upgrades/${version}.md     folded from unreleased.md (previous: ${previous ?? 'null'})`,
    `✔ docs/upgrades/unreleased.md    reset`,
    `✔ CHANGELOG.md                   '## ${version}' prepended`,
    `✔ package.json                   ${version}`,
    `✔ .rocketflare.json              kit.version ${version}`,
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
