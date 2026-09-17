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
 * Surfaces a LATER release retired, and the release that did it.
 *
 * A released note is never rewritten (`docs/CONCEPTS.md` §13) — every copy of the kit pins a
 * commit, and editing history orphans them — so a note that named a surface keeps naming it after
 * the surface goes. Listing them here is what keeps the typo check below meaningful for the note
 * somebody is writing TODAY, which is the only note it can still protect.
 */
const RETIRED_SURFACE_IDS: Record<string, string> = {
  // 0.6.0: analytics left the kit for `rocketflare-plugin-analytics` (D31, Phase C), taking its
  // two example cubes, its example dashboard template and the optional-feature surface with it.
  'feature-analytics': '0.6.0',
  'example-cube-activity-events': '0.6.0',
  'example-cube-tenant-activity-daily': '0.6.0',
  'example-dashboard-tenant-overview': '0.6.0',
}

describe('release notes', () => {
  it('there is at least one, and it is the baseline', () => {
    expect(releases.length).toBeGreaterThan(0)
    expect(parseNote(read(`${releases[0]}.md`))?.data.previous).toBe(null)
  })

  it.each(releases)('%s parses, and its frontmatter is well formed', version => {
    const parsed = parseNote(read(`${version}.md`))
    expect(parsed, 'frontmatter').not.toBeNull()
    const { data } = parsed!
    expect(data.version).toBe(version)
    expect(typeof data.breaking).toBe('boolean')
    expect(typeof data.manual).toBe('boolean')
    expect(Array.isArray(data.migrations)).toBe(true)
    expect(Array.isArray(data.areas)).toBe(true)
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it.each(releases)('%s chains to the release before it', version => {
    const i = releases.indexOf(version)
    const previous = i === 0 ? null : releases[i - 1]
    expect(parseNote(read(`${version}.md`))?.data.previous ?? null).toBe(previous)
  })

  it.each(releases)('%s carries the four headings, in order', version => {
    const body = parseNote(read(`${version}.md`))!.body
    let cursor = -1
    for (const heading of NOTE_HEADINGS) {
      const at = body.indexOf(`\n${heading}`)
      expect(at, heading).toBeGreaterThan(-1)
      expect(at, `${heading} out of order`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it.each(releases)('%s names only real surfaces', version => {
    const { data } = parseNote(read(`${version}.md`))!
    for (const key of ['touches_surfaces', 'requires_surfaces'] as const) {
      for (const id of (data[key] as string[] | undefined) ?? []) {
        if (RETIRED_SURFACE_IDS[id]) continue
        expect(surfaceIds, `${version}: ${key} names '${id}'`).toContain(id)
      }
    }
  })

  it.each(releases)('%s describes migrations, never names their files', version => {
    // An adopter regenerates their own migration; the kit's file number and snapshot are
    // meaningless — and dangerous — in their tree.
    for (const m of (parseNote(read(`${version}.md`))!.data.migrations as string[]) ?? []) {
      expect(m, 'describe the schema change, not the file').not.toMatch(/\.sql$|^\d{4}_/)
    }
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
})
