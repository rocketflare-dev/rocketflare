/**
 * Kit-only checks on the shared libs: the pieces of `scripts/lib/*` that serve the kit's OWN
 * release flow — the porting-note predicate (`release-check --unreleased`, the changelog nudge),
 * the tag gate's changelog lookup — and the property that keeps the manifest's fixed filenames
 * out of the rename's reach in the kit's source. A copy never cuts a kit release, so its gate does
 * not re-prove them (`docs/CONCEPTS.md` §13).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MANIFEST_FILE, SIDECAR_FILE } from '../../../../scripts/lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from '../../../../scripts/lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, KIT } from '../../../../scripts/lib/rename-lib.mjs'
import { behaviourFiles, hasChangelogSection } from '../../../../scripts/lib/upgrade-lib.mjs'

describe('behaviourFiles', () => {
  // The porting-note predicate, shared by the CI gate (`release-check --unreleased`) and the
  // pre-commit hook (`changelog-nudge.mjs`). They were two copies of one regex pair, and a hook
  // that disagrees with the gate is a hook people learn to ignore.
  it('is source under apps/ or packages/, tests and markdown excluded', () => {
    expect(
      behaviourFiles([
        'apps/web/src/api/index.ts',
        'packages/shared/src/jobs.ts',
        'apps/web/tests/api/chat.test.ts',
        'apps/web/src/api/thing.test.ts',
        'apps/web/src/ui/CLAUDE.md',
        'docs/CONCEPTS.md',
        'scripts/release.mjs',
        '.github/workflows/ci.yml',
      ])
    ).toEqual(['apps/web/src/api/index.ts', 'packages/shared/src/jobs.ts'])
    expect(behaviourFiles([])).toEqual([])
    expect(behaviourFiles(undefined)).toEqual([])
  })
})

describe('hasChangelogSection', () => {
  const changelog = '# Changelog\n\n## 0.6.10 — 2026-01-02\n\nx\n\n## 0.6.1 — 2026-01-01\n\ny\n'

  it('does not accept 0.6.10 as 0.6.1 — the bug a two-digit patch would have found', () => {
    // `changelog.includes('## 0.6.1')` is true of `## 0.6.10`, so the tag gate would have passed
    // on another release's section, in the direction that lets a release through.
    expect(hasChangelogSection('# Changelog\n\n## 0.6.10 — 2026-01-02\n', '0.6.1')).toBe(false)
    expect(hasChangelogSection(changelog, '0.6.1')).toBe(true)
    expect(hasChangelogSection(changelog, '0.6.10')).toBe(true)
    expect(hasChangelogSection(changelog, '0.7.0')).toBe(false)
  })

  it('anchors to the start of a line, so a mention in prose is not a section', () => {
    expect(hasChangelogSection('see ## 0.6.1 below\n', '0.6.1')).toBe(false)
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
