/**
 * `.rocketflare.json` is what lets a copy of the kit absorb later kit releases: it records where
 * the copy came from, and it classifies every file the kit ships. `scripts/upgrade.mjs` uses that
 * classification to decide, per file, whether a kit change may be applied — and the one outcome
 * that breaks somebody's app is recreating a surface they deleted.
 *
 * So the manifest has to stay true as the kit grows. The coverage assertion below is the check
 * that does it: every tracked file must be claimed by a surface, the never-port list, the manual
 * list or a core prefix. Add a directory the manifest has never heard of and this test fails until
 * somebody says what it is. Same spirit as `rls-coverage.test.ts` and `cube-isolation.test.ts`.
 *
 * The `config` project: no database, no filesystem beyond `git ls-files`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  absentSurfaces,
  classifyPath,
  isKitManifest,
  matchesAny,
} from '../../../../scripts/lib/upgrade-lib.mjs'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const committed = rawManifest as unknown as Manifest

/**
 * What the tooling actually sees: the committed manifest with the git-ignored
 * `.rocketflare.local.json` sidecar folded in (D31). In the kit that is where a plugin installed
 * with `--local` is recorded, so a developer with one installed must not fail this suite — and its
 * files must still be classified, which is exactly what the coverage assertion below then proves.
 */
const manifest = (readManifest().manifest ?? committed) as Manifest

const REPO_ROOT = path.resolve(__dirname, '../../../..')
// Tracked AND untracked-but-not-ignored — the same file set `scripts/rename.mjs` walks. A new file
// that nobody has classified yet should fail this suite before it is committed, not after.
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')

describe('.rocketflare.json', () => {
  it('is the kit, not an app (the `app` block is what a copy gets)', () => {
    // The COMMITTED file, deliberately: the sidecar may not make a checkout look like something
    // else, and `readManifest().isKit` answers from the same place.
    expect(isKitManifest(committed)).toBe(true)
    expect(readManifest().isKit).toBe(true)
    expect(committed.kit.name).toBe('rocketflare')
    expect(committed.kit.repo).toMatch(/^https:\/\/github\.com\/.+\.git$/)
  })

  it('carries the two prose keys that stop it being deleted as cruft', () => {
    expect(committed.$purpose).toMatch(/kit:upgrade/)
    expect(committed.$doNotDelete).toMatch(/--adopt/)
  })

  it('pins a version that matches the root package.json', async () => {
    const root = await import('../../../../package.json')
    expect(committed.kit.version).toBe(root.default.version)
  })
})

describe('surfaces', () => {
  it('every anchor is a tracked FILE, and unique', () => {
    const anchors = new Set<string>()
    for (const s of manifest.surfaces) {
      expect(tracked, `${s.id} anchor`).toContain(s.anchor)
      // Presence is `existsSync` on the anchor, so a directory would always read as present.
      expect(statSync(path.join(REPO_ROOT, s.anchor)).isFile(), `${s.id} anchor is a file`).toBe(
        true
      )
      expect(anchors.has(s.anchor), `${s.id} anchor is unique`).toBe(false)
      anchors.add(s.anchor)
    }
  })

  it('every declared path matches at least one tracked file', () => {
    for (const s of manifest.surfaces) {
      for (const glob of s.paths) {
        expect(
          tracked.some(f => matchesAny(f, [glob])),
          `${s.id}: ${glob}`
        ).toBe(true)
      }
    }
  })

  it('every registry it names still exists', () => {
    for (const s of manifest.surfaces) {
      for (const ref of s.registries) {
        expect(tracked, `${s.id}: ${ref}`).toContain(ref.split('#')[0])
      }
    }
  })

  it('ids are unique and kinds are known', () => {
    const ids = manifest.surfaces.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of manifest.surfaces)
      expect(['example', 'optional-feature', 'plugin']).toContain(s.kind)
  })

  it('every plugin surface says where it came from', () => {
    // D31: `source.repo` is never null. An installed plugin whose origin is unknown cannot be
    // upgraded, cannot be checked against its `requires.kit` range, and cannot be re-fetched — so
    // it would be a directory nobody can maintain, recorded as though somebody could.
    for (const s of manifest.surfaces.filter(x => x.kind === 'plugin')) {
      expect(s.source?.repo, `${s.id} source.repo`).toBeTruthy()
      expect(s.anchor, `${s.id} anchor`).toMatch(/^apps\/web\/src\/plugins\/[^/]+\//)
    }
  })

  it('every installed plugin directory is a declared surface', () => {
    // The manifest is what `kit:upgrade` reads to leave a plugin's bytes alone. A plugin on disk
    // that no surface claims would be treated as core and rewritten by the next kit release.
    const dir = path.join(REPO_ROOT, 'apps/web/src/plugins')
    const installed = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
      : []
    const declared = new Set(manifest.surfaces.filter(s => s.kind === 'plugin').map(s => s.id))
    expect(
      installed.filter(id => !declared.has(id)),
      'run `pnpm plugin add` rather than copying a plugin in by hand'
    ).toEqual([])
  })

  it('reports nothing absent in the kit itself', () => {
    expect(absentSurfaces(manifest, tracked)).toEqual([])
  })
})

describe('never-port and manual lists', () => {
  it('name files that exist, so a rename cannot silently empty them', () => {
    for (const glob of [...manifest.neverPort, ...manifest.manual]) {
      expect(
        tracked.some(f => matchesAny(f, [glob])),
        glob
      ).toBe(true)
    }
  })

  it('never translate a file the rename itself refuses to touch', async () => {
    // Such a file is untranslated in an adopted tree. Porting it TRANSLATED would apply a patch
    // whose context cannot match — a silent, guaranteed conflict.
    const { EXCLUDED_PATHS, EXCLUDED_PREFIXES } = await import(
      '../../../../scripts/lib/rename-lib.mjs'
    )
    const excluded = [
      // Only entries that still exist: the list keeps a couple of paths from older layouts so an
      // older copy is renamed correctly, and a file the kit no longer ships never appears in a diff.
      ...EXCLUDED_PATHS.filter(p => tracked.includes(p)),
      ...EXCLUDED_PREFIXES.map(prefix => tracked.find(f => f.startsWith(prefix))).filter(Boolean),
    ] as string[]
    expect(excluded.length).toBeGreaterThan(5)
    for (const p of excluded) {
      const c = classifyPath(p, { manifest, existsLocally: true, change: 'modified' })
      expect(c.translate, `${p} must not be translated`).toBe(false)
    }
  })
})

describe('coverage', () => {
  it('classifies every tracked file', () => {
    const all = [
      ...manifest.surfaces.flatMap(s => s.paths),
      ...manifest.neverPort,
      ...manifest.manual,
      ...manifest.core,
    ]
    const unclassified = tracked.filter(f => !matchesAny(f, all))
    expect(
      unclassified,
      'add these to a surface, neverPort, manual or core in .rocketflare.json'
    ).toEqual([])
  })

  it('the kit ships the upgrade tooling it promises', () => {
    for (const f of [
      'scripts/upgrade.mjs',
      'scripts/lib/upgrade-lib.mjs',
      'scripts/lib/upgrade-lib.d.mts',
      'scripts/release-check.mjs',
      'scripts/release.mjs',
      'docs/upgrades/README.md',
      'docs/upgrades/unreleased.md',
      'CHANGELOG.md',
    ]) {
      expect(existsSync(path.join(REPO_ROOT, f)), f).toBe(true)
    }
  })
})
