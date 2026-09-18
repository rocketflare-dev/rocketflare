/**
 * The release notes under `docs/upgrades/` are the instruction set a copy of the kit follows to
 * absorb a later release. They are only useful if the chain is unbroken and the shape is
 * predictable, because `scripts/upgrade.mjs` and the `/rf-upgrade` skill both read them
 * mechanically. This file is what keeps them that way — including the guard that a release cannot
 * be cut without one. The `config` project: no database.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import root from '../../../../package.json'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  compareVersions,
  NOTE_HEADINGS,
  noteProblems,
  parseNote,
  VERSION_RE,
} from '../../../../scripts/lib/upgrade-lib.mjs'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const manifest = rawManifest as unknown as Manifest

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const UPGRADES = path.join(REPO_ROOT, 'docs', 'upgrades')
const read = (f: string) => readFileSync(path.join(UPGRADES, f), 'utf8')

const releases = readdirSync(UPGRADES)
  .filter(f => VERSION_RE.test(f.replace(/\.md$/, '')))
  .map(f => f.replace(/\.md$/, ''))
  .sort(compareVersions)

const surfaceIds = new Set(manifest.surfaces.map(s => s.id))

/**
 * Surfaces a LATER release retired — read from `.rocketflare.json`, not restated here.
 *
 * A released note is never rewritten (`docs/CONCEPTS.md` §13): every copy of the kit pins a commit
 * and editing history orphans them, so a note keeps naming a surface after the surface goes. This
 * list used to be a const in THIS file, which meant `scripts/release-check.mjs --tag 0.2.0` — the
 * gate that proves a released tag is still intact — reported those notes as broken while the suite
 * called them fine. Two readers, one list, in the manifest they both already open.
 */
const retiredSurfaceIds = manifest.retiredSurfaces ?? {}

describe('release notes', () => {
  it('there is at least one, and it is the baseline', () => {
    expect(releases.length).toBeGreaterThan(0)
    expect(parseNote(read(`${releases[0]}.md`))?.data.previous).toBe(null)
  })

  /**
   * The whole schema, through the one function `scripts/release-check.mjs --tag` also calls:
   * frontmatter shape, the unbroken `previous` chain, the date, migrations described rather than
   * named, only real (or deliberately retired) surfaces, and the four headings in order.
   *
   * It was five assertions here and a second copy in `release-check.mjs`, and they had drifted.
   */
  it.each(releases)('%s is a well-formed porting note', version => {
    const i = releases.indexOf(version)
    expect(
      noteProblems(read(`${version}.md`), {
        file: `docs/upgrades/${version}.md`,
        version,
        expectPrevious: i === 0 ? 'null' : releases[i - 1],
        surfaceIds: [...surfaceIds],
        retiredSurfaceIds,
      })
    ).toEqual([])
  })

  it('no note is newer than the version the kit claims to be', () => {
    // A note for a version that was never released dangles: an adopter's `--from` would resolve to
    // a tag that does not exist. `pnpm kit:release` writes the note and the version bump together.
    const newest = releases[releases.length - 1]
    expect(
      compareVersions(newest, root.version),
      `docs/upgrades/${newest}.md exists but the kit is ${root.version}`
    ).toBeLessThanOrEqual(0)
  })

  it('a release cannot be cut without its note', () => {
    expect(
      releases.includes(root.version),
      `root package.json is ${root.version} but docs/upgrades/${root.version}.md does not exist — run \`pnpm kit:release ${root.version}\``
    ).toBe(true)
    expect(manifest.kit.version).toBe(root.version)
  })
})

describe('unreleased.md', () => {
  const text = read('unreleased.md')

  it('exists, parses, and follows the newest release', () => {
    const parsed = parseNote(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.data.version).toBe('unreleased')
    expect(parsed!.data.previous).toBe(releases[releases.length - 1])
  })

  it('carries the same four headings a release note must have', () => {
    for (const heading of NOTE_HEADINGS) expect(parseNote(text)!.body).toContain(heading)
  })

  it('is judged by the same function, with no version and no date to check', () => {
    // `unreleased.md` has `version: unreleased` and `date: null` by design, so a caller passes
    // `version: null` and those two checks are skipped rather than failed.
    expect(noteProblems(text, { file: 'unreleased.md', version: null })).toEqual([])
  })
})

/**
 * The schema function itself, over fixtures — because every assertion above passes trivially if it
 * silently checks nothing, and the notes on disk are all (correctly) well formed.
 */
describe('noteProblems', () => {
  const note = (frontmatter: string, body = '') => `---\n${frontmatter}\n---\n${body}`
  const HEADINGS = '\n## What changed\nx\n## How to apply\n## Conflicts to expect\n## Verify\n'
  const GOOD = `version: 0.9.0
previous: 0.8.0
date: 2026-01-02
breaking: false
migrations: ["a budget column on agent_runs"]
areas: [api]
touches_surfaces: [feature-chat]
requires_surfaces: []
manual: false`
  const check = (frontmatter: string, body = HEADINGS, options = {}) =>
    noteProblems(note(frontmatter, body), {
      file: 'n.md',
      version: '0.9.0',
      expectPrevious: '0.8.0',
      surfaceIds: ['feature-chat'],
      ...options,
    })

  it('passes a well-formed note', () => {
    expect(check(GOOD)).toEqual([])
  })

  it('reports a missing frontmatter, and nothing else — there is nothing else to read', () => {
    expect(noteProblems('# just a heading\n', { file: 'n.md' })).toEqual([
      'n.md: no YAML frontmatter',
    ])
  })

  it('catches a version, date or chain that does not match', () => {
    expect(check(GOOD.replace('version: 0.9.0', 'version: 0.9.1'))[0]).toMatch(
      /frontmatter version/
    )
    expect(check(GOOD.replace('date: 2026-01-02', 'date: null'))[0]).toMatch(/expected YYYY-MM-DD/)
    expect(check(GOOD.replace('previous: 0.8.0', 'previous: 0.7.0'))[0]).toMatch(/must be unbroken/)
    // The baseline note is the one whose `previous` is the literal string 'null'.
    expect(
      check(GOOD.replace('previous: 0.8.0', 'previous: null'), HEADINGS, {
        expectPrevious: 'null',
      })
    ).toEqual([])
  })

  it('insists the booleans are booleans and the lists are lists', () => {
    expect(check(GOOD.replace('breaking: false', 'breaking: maybe'))[0]).toMatch(
      /breaking must be true or false/
    )
    expect(check(GOOD.replace('areas: [api]', 'areas: api'))[0]).toMatch(/areas must be a list/)
  })

  it('refuses a migration named as a FILE rather than described', () => {
    // An adopter regenerates their own; the kit's file number is meaningless in their tree.
    expect(check(GOOD.replace('"a budget column on agent_runs"', '"0012_budget.sql"'))[0]).toMatch(
      /describe the change/
    )
  })

  it('reports an unknown surface, accepts a RETIRED one, and skips the check with no manifest', () => {
    const named = GOOD.replace('[feature-chat]', '[feature-analytics]')
    expect(check(named)[0]).toMatch(/touches_surfaces names 'feature-analytics'/)
    // The whole point of `retiredSurfaces`: 0.2.0 and 0.3.0 name a surface 0.6.0 deleted, and a
    // released note is never rewritten.
    expect(check(named, HEADINGS, { retiredSurfaceIds: { 'feature-analytics': '0.6.0' } })).toEqual(
      []
    )
    // No manifest is "I cannot check", not "every id is wrong".
    expect(check(named, HEADINGS, { surfaceIds: null })).toEqual([])
  })

  it('wants the four headings, in order', () => {
    expect(check(GOOD, '\n## What changed\n## How to apply\n## Verify\n')).toEqual([
      "n.md: missing the '## Conflicts to expect' heading",
    ])
    const swapped = '\n## How to apply\n## What changed\n## Conflicts to expect\n## Verify\n'
    expect(check(GOOD, swapped)[0]).toMatch(/out of order/)
  })

  it('names the manifest the way its caller does', () => {
    // The provenance file keeps the KIT's name in a renamed copy, so the literal cannot live in
    // `upgrade-lib.mjs` — the rename would rewrite it into a filename that does not exist.
    const problems = check(GOOD.replace('[feature-chat]', '[nope]'), HEADINGS, {
      manifestFile: '.rocketflare.json',
    })
    expect(problems[0]).toContain('.rocketflare.json')
  })
})
