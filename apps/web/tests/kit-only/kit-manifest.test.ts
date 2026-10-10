/**
 * What `.rocketflare.json` claims about the KIT itself — a kit-only suite (`docs/CONCEPTS.md` §13):
 * `scripts/rename.mjs` deletes this directory when a copy is born, because every claim here is
 * false in a copy on purpose. A copy deletes surfaces (that IS the design — `absentSurfaces`, the
 * `existsSync` anchor rule), and its root `package.json` version is its own release, not the kit
 * release it came from. What is true of ANY manifest is in `tests/config/kit-manifest.test.ts`,
 * which travels.
 *
 * The `kit-only` project: no database, no filesystem beyond `git ls-files`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import root from '../../../../package.json'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  absentSurfaces,
  classifyPath,
  isKitManifest,
  KIT_ONLY_PATHS,
  kitOnlyGlobs,
  matchesAny,
} from '../../../../scripts/lib/upgrade-lib.mjs'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const committed = rawManifest as unknown as Manifest
// The committed manifest with the git-ignored sidecar folded in (D31) — what the tooling sees.
const manifest = (readManifest().manifest ?? committed) as Manifest

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => existsSync(path.join(REPO_ROOT, f)))

describe('.rocketflare.json in the kit', () => {
  it('is the kit, not an app (the `app` block is what a copy gets)', () => {
    expect(isKitManifest(committed)).toBe(true)
    expect(readManifest().isKit).toBe(true)
  })

  it('carries the two prose keys that stop it being deleted as cruft', () => {
    expect(committed.$purpose).toMatch(/kit:upgrade/)
    expect(committed.$doNotDelete).toMatch(/--adopt/)
  })

  it('pins a version that matches the root package.json', () => {
    // In an app the root version is the APP's release, while `kit.version` records the kit release
    // it last absorbed — different numbers on purpose, which is why this file is kit-only.
    expect(committed.kit.version).toBe(root.version)
  })
})

describe('surfaces in the kit', () => {
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

  it('reports nothing absent in the kit itself', () => {
    expect(absentSurfaces(manifest, tracked)).toEqual([])
  })
})

describe('never-port, kit-only and manual lists in the kit', () => {
  it('name files that exist, so a rename cannot silently empty them', () => {
    for (const glob of [...manifest.neverPort, ...(manifest.kitOnly ?? []), ...manifest.manual]) {
      expect(
        tracked.some(f => matchesAny(f, [glob])),
        glob
      ).toBe(true)
    }
  })

  it('declares the kit-only floor, so a copy made today inherits the whole list', () => {
    // The rename keeps `.rocketflare.json` verbatim, so a copy's list is the one written here.
    for (const glob of KIT_ONLY_PATHS) expect(committed.kitOnly ?? []).toContain(glob)
    expect(new Set(kitOnlyGlobs(committed))).toEqual(new Set(committed.kitOnly))
  })
})

describe('the tooling the kit ships', () => {
  it('includes the upgrade and release tooling it promises', () => {
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

describe('launch.kit.json in the kit (the Launch kit contract, D36)', () => {
  const launch = JSON.parse(readFileSync(path.join(REPO_ROOT, 'launch.kit.json'), 'utf8'))

  it('mirrors defaultPlugins, which stays the source of truth (the bootstrap and kit.yml read it)', () => {
    expect(launch.plugins.defaults).toEqual(committed.defaultPlugins)
  })

  it('points the upgrade notes at a note every release has', () => {
    const note = launch.upgrade.notes.replace('{version}', root.version)
    expect(existsSync(path.join(REPO_ROOT, note)), note).toBe(true)
    expect(existsSync(path.join(REPO_ROOT, launch.upgrade.skill))).toBe(true)
  })

  it('is manual for kit:upgrade: its kit block must never go through the token map', () => {
    expect(classifyPath('launch.kit.json', { manifest, existsLocally: true }).class).toBe('manual')
  })
})
