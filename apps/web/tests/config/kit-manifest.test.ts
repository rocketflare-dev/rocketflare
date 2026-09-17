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
import { KIT } from '../../../../scripts/lib/rename-lib.mjs'
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

/**
 * This suite travels into every adopted copy, and half of what it asserts is only true of the KIT.
 *
 * A copy deletes surfaces on purpose — that IS the design (`absentSurfaces`, `existsSync` on the
 * anchor) — and its root `package.json` version is its own release, not the kit release it came
 * from. Asserted unconditionally, those claims made an app's very first `pnpm test` red, which is
 * the opposite of what D27 promises. So the disk-state and provenance claims run only in the kit;
 * everything that is true of ANY manifest — ids unique, kinds known, every plugin surface says
 * where it came from, every plugin directory is declared, 100% coverage — runs everywhere, because
 * that is where they earn their keep.
 */
const { isKit } = readManifest()
const kitOnly = it.skipIf(!isKit)

const REPO_ROOT = path.resolve(__dirname, '../../../..')
// Tracked AND untracked-but-not-ignored — the same file set `scripts/rename.mjs` walks. A new file
// that nobody has classified yet should fail this suite before it is committed, not after.
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  // `git ls-files` reads the INDEX, so a file deleted on disk and not yet staged is still listed.
  // `pnpm plugin remove --apply` deletes three directories and the gate runs BEFORE any `git add`,
  // so without this filter the scan dies with ENOENT on a file the tool correctly removed.
  .filter(f => existsSync(path.join(REPO_ROOT, f)))

describe('.rocketflare.json', () => {
  it('names the KIT, in the kit and in every copy', () => {
    // The rename leaves this file alone by design, so the provenance is the same string everywhere
    // — which is what `kit:upgrade` descends from.
    expect(committed.kit.name).toBe(KIT.slug)
    expect(committed.kit.repo).toMatch(/^https:\/\/github\.com\/.+\.git$/)
    // …and the two readers agree about which checkout this is, whichever it is.
    expect(isKitManifest(committed)).toBe(committed.app == null)
    expect(isKit).toBe(committed.app == null)
  })

  kitOnly('is the kit, not an app (the `app` block is what a copy gets)', () => {
    expect(isKitManifest(committed)).toBe(true)
    expect(isKit).toBe(true)
  })

  kitOnly('carries the two prose keys that stop it being deleted as cruft', () => {
    expect(committed.$purpose).toMatch(/kit:upgrade/)
    expect(committed.$doNotDelete).toMatch(/--adopt/)
  })

  kitOnly('pins a version that matches the root package.json', async () => {
    // Kit-only: in an app the root version is the APP's release, while `kit.version` records the
    // kit release it last absorbed. They are different numbers on purpose.
    const root = await import('../../../../package.json')
    expect(committed.kit.version).toBe(root.default.version)
  })
})

describe('surfaces', () => {
  // The next three are kit-only: a copy DELETES surfaces on purpose and the entries stay behind —
  // `absentSurfaces` and the `existsSync` anchor rule exist for exactly that state — so asserting
  // that every anchor, path and registry is still on disk would fail every app that used the kit
  // the way it is meant to be used. Uniqueness and shape, below, are about the manifest and run
  // everywhere.
  kitOnly('every anchor is a tracked FILE, and unique', () => {
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

  kitOnly('every declared path matches at least one tracked file', () => {
    for (const s of manifest.surfaces) {
      for (const glob of s.paths) {
        expect(
          tracked.some(f => matchesAny(f, [glob])),
          `${s.id}: ${glob}`
        ).toBe(true)
      }
    }
  })

  kitOnly('every registry it names still exists', () => {
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

  kitOnly('reports nothing absent in the kit itself', () => {
    expect(absentSurfaces(manifest, tracked)).toEqual([])
  })
})

describe('never-port and manual lists', () => {
  kitOnly('name files that exist, so a rename cannot silently empty them', () => {
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
