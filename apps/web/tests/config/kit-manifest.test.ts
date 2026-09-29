/**
 * `.rocketflare.json` is what lets a copy of the kit absorb later kit releases: it records where
 * the copy came from, and it classifies every file the kit ships. `scripts/upgrade.mjs` uses that
 * classification to decide, per file, whether a kit change may be applied — and the one outcome
 * that breaks somebody's app is recreating a surface they deleted.
 *
 * So the manifest has to stay true as the kit grows. The coverage assertion below is the check
 * that does it: every tracked file must be claimed by a surface, the never-port list, the kit-only
 * list, the manual list or a core prefix. Add a directory the manifest has never heard of and this
 * test fails until somebody says what it is. Same spirit as `rls-coverage.test.ts` and
 * `cube-isolation.test.ts`.
 *
 * This suite travels into every copy, so everything here is true of ANY manifest — the kit's and
 * an app's alike. The claims that hold only of the KIT (its disk state, its version pin, the
 * tooling it ships) are in `tests/kit-only/kit-manifest.test.ts`, which a copy never carries
 * (`docs/CONCEPTS.md` §13).
 *
 * The `config` project: no database, no filesystem beyond `git ls-files`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'
import { KIT } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  classifyPath,
  isKitManifest,
  KIT_ONLY_PROJECT,
  kitOnlyGlobs,
  matchesAny,
} from '../../../../scripts/lib/upgrade-lib.mjs'
import { RESERVED_PLUGIN_IDS } from '../helpers/plugins'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const committed = rawManifest as unknown as Manifest

/**
 * What the tooling actually sees: the committed manifest with the git-ignored
 * `.rocketflare.local.json` sidecar folded in (D31). In the kit that is where a plugin installed
 * with `--local` is recorded, so a developer with one installed must not fail this suite — and its
 * files must still be classified, which is exactly what the coverage assertion below then proves.
 */
const manifest = (readManifest().manifest ?? committed) as Manifest
const { isKit } = readManifest()

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
})

describe('surfaces', () => {
  // Whether each anchor, path and registry is still on disk is a KIT-only claim
  // (`tests/kit-only/`): a copy DELETES surfaces on purpose and the entries stay behind —
  // `absentSurfaces` and the `existsSync` anchor rule exist for exactly that state. Uniqueness and
  // shape are about the manifest and hold everywhere.
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
          // `plugins/api/**` is the host's plugin API, not an installed plugin — the same reserved
          // set that stops anybody taking `api` as a plugin id (D31).
          .filter(e => !RESERVED_PLUGIN_IDS.has(e.name))
          .map(e => e.name)
      : []
    const declared = new Set(manifest.surfaces.filter(s => s.kind === 'plugin').map(s => s.id))
    expect(
      installed.filter(id => !declared.has(id)),
      'run `pnpm plugin add` rather than copying a plugin in by hand'
    ).toEqual([])
  })
})

describe('never-port and manual lists', () => {
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

/**
 * The kit's own tests (`kitOnly`, `docs/CONCEPTS.md` §13) are in the kit and in NOTHING made from
 * it. One assertion that means something in both places: in the kit they exist and the gate runs
 * them; in a copy there is not one file and not one script left that names them. A copy that
 * carries one — an upgrade that slipped it in, a hand copy — fails here, in its own gate, before
 * a kit-only assertion (the root version IS the kit's, say) can fail it for the wrong reason.
 */
describe('kit-only tests', () => {
  const globs = kitOnlyGlobs(committed)
  const present = tracked.filter(f => matchesAny(f, globs))
  const webPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')
  ) as { scripts?: Record<string, string> }
  const flag = new RegExp(`--project[ =]${KIT_ONLY_PROJECT}(?![\\w-])`)
  const wired = Object.values(webPackage.scripts ?? {}).some(command => flag.test(command))

  it(isKit ? 'exist in the kit' : 'are not in this copy', () => {
    expect(present.length > 0, present.join(', ') || 'no kit-only file').toBe(isKit)
  })

  it(isKit ? 'are run by the kit’s gate' : 'are not wired into this copy’s gate', () => {
    expect(wired, `a \`--project ${KIT_ONLY_PROJECT}\` in apps/web/package.json`).toBe(isKit)
  })
})

describe('coverage', () => {
  it('classifies every tracked file', () => {
    const all = [
      ...manifest.surfaces.flatMap(s => s.paths),
      ...manifest.neverPort,
      ...kitOnlyGlobs(manifest),
      ...manifest.manual,
      ...manifest.core,
    ]
    const unclassified = tracked.filter(f => !matchesAny(f, all))
    expect(
      unclassified,
      'add these to a surface, neverPort, kitOnly, manual or core in .rocketflare.json'
    ).toEqual([])
  })
})
