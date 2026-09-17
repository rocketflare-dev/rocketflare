/**
 * `scripts/lib/manifest.mjs` — the one place the kit-vs-app question is answered, and the one
 * place the git-ignored `.rocketflare.local.json` sidecar is folded in (D31).
 *
 * Why this matters enough to test: every plugin command decides WHERE to record an install from
 * `isKit`, and every reader decides WHAT is installed from the merged surfaces. Get the merge wrong
 * and a plugin is either invisible to `plugin check` or committed into a kit release, which is a
 * copy of somebody else's wiring arriving in every app made from that commit.
 *
 * The `config` project: no database, and the only I/O is reading the repo's own two files.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_FILE,
  mergeSidecar,
  pluginSurfaces,
  readManifest,
  SIDECAR_FILE,
} from '../../../../scripts/lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from '../../../../scripts/lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, KIT } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest, Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'

const surface = (id: string, kind: Surface['kind'] = 'plugin'): Surface => ({
  id,
  kind,
  label: id,
  anchor: `apps/web/src/plugins/${id}/plugin.json`,
  paths: [`apps/web/src/plugins/${id}/**`],
  registries: ['apps/web/src/plugins/server.ts'],
})

const base = {
  $purpose: 'x',
  $doNotDelete: 'y',
  kit: { name: KIT.slug, repo: 'r', version: '0.5.0', commit: null },
  app: null,
  history: [],
  surfaces: [surface('feature-chat', 'optional-feature')],
  neverPort: [],
  manual: [],
  core: [],
} satisfies Manifest

describe('mergeSidecar', () => {
  it('is the manifest itself when there is no sidecar', () => {
    expect(mergeSidecar(base, null)).toBe(base)
    expect(mergeSidecar(base, { surfaces: [] })).toBe(base)
  })

  it('appends the sidecar surfaces without touching anything else', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    expect(merged?.surfaces.map(s => s.id)).toEqual(['feature-chat', 'analytics'])
    expect(merged?.kit).toEqual(base.kit)
    expect(merged?.app).toBeNull()
    // The committed manifest is not mutated — a writer reads it back to write it out.
    expect(base.surfaces).toHaveLength(1)
  })

  it('lets a local entry replace a committed one of the same id', () => {
    const local = { ...surface('feature-chat', 'plugin'), label: 'local copy' }
    const merged = mergeSidecar(base, { surfaces: [local] })
    expect(merged?.surfaces).toHaveLength(1)
    expect(merged?.surfaces[0]?.label).toBe('local copy')
  })

  it('survives a missing manifest', () => {
    expect(mergeSidecar(null, { surfaces: [surface('analytics')] })).toBeNull()
  })
})

describe('pluginSurfaces', () => {
  it('is only the plugin kind', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    expect(pluginSurfaces(merged).map(s => s.id)).toEqual(['analytics'])
    expect(pluginSurfaces(null)).toEqual([])
  })
})

describe('readManifest', () => {
  it('reads this repository, and agrees with the committed file about which it is', () => {
    const { manifest, isKit, sidecar, manifestPath, sidecarPath } = readManifest()
    // Not `toBe(true)`: this suite also runs in every adopted copy, where the honest answer is
    // `false`. What must hold in both is that `isKit` is the `app === null` question and nothing
    // else — a renamed app failing the kit's own identity assertion is a red gate on day one.
    expect(isKit).toBe(manifest?.app == null)
    // The provenance names the KIT even in a copy: the rename deliberately leaves this file alone.
    expect(manifest?.kit.name).toBe(KIT.slug)
    expect(manifestPath.endsWith(MANIFEST_FILE)).toBe(true)
    expect(sidecarPath.endsWith(SIDECAR_FILE)).toBe(true)
    // The sidecar is git-ignored, so a developer's checkout may legitimately have one; what must
    // hold either way is that `isKit` reads the COMMITTED file, never the merged view.
    expect(sidecar === null || typeof sidecar === 'object').toBe(true)
  })

  it('is honest about a directory that has no manifest at all', () => {
    const { manifest, isKit, sidecar } = readManifest('/')
    expect(manifest).toBeNull()
    expect(sidecar).toBeNull()
    // Not the kit: an unknown state is not a licence to behave like it.
    expect(isKit).toBe(false)
  })
})

/**
 * The three filenames the whole plugin toolchain addresses by literal name — the provenance file,
 * its sidecar and a plugin repository's manifest — are the SAME in the kit and in every renamed
 * copy. `.rocketflare.json` is on the rename's exclusion list by design (it describes the kit), and
 * a plugin repository ships one filename for the whole ecosystem.
 *
 * Written as literals, `scripts/rename.mjs` rewrote all three: a copy renamed to `acme` looked for
 * `.acme.json`, found nothing, and every `pnpm plugin` command died with "not found" against a file
 * sitting in the root. Nothing in the kit's own suite could see it, because in the kit the two
 * spellings are the same string. Building them from `KIT.slug` — which lives in a file the rename
 * skips — is what makes them survive, and this is the test that says so.
 */
describe('the fixed filenames survive a rename', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..')
  const names = deriveNames('acme', 'Acme')
  const translate = (rel: string) =>
    applyReplacements(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), names).text

  it('belong to the kit, not to the app', () => {
    expect(MANIFEST_FILE).toBe(`.${KIT.slug}.json`)
    expect(SIDECAR_FILE).toBe(`.${KIT.slug}.local.json`)
    expect(PLUGIN_MANIFEST_FILE).toBe(`${KIT.slug}-plugin.json`)
  })

  it('are not written as literals the rename can rewrite', () => {
    for (const rel of ['scripts/lib/manifest.mjs', 'scripts/lib/plugin-lib.mjs']) {
      const renamed = translate(rel)
      // Quoted, so a prose mention in a JSDoc block (which the rename also rewrites, harmlessly)
      // is not what this is about — only a STRING the code would then go looking for.
      expect(renamed).not.toMatch(/'\.acme\.json'/)
      expect(renamed).not.toMatch(/'acme-plugin\.json'/)
      expect(renamed).toContain('KIT.slug')
    }
  })
})
