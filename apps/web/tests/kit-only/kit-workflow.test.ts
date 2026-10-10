/**
 * `.github/workflows/kit.yml` — the kit's OWN checks, which no copy carries (`kitOnly`). What it
 * promises lives only in YAML, so it is pinned here: the renamed copy and the default plugins are
 * gated with the same `pnpm gate` a copy runs (the plugins pass with the whole suite under neon —
 * the driver seam's backstop), and the checks that are only the kit's business (the published
 * plugin API, the vendored plugin's audit, the porting note, `defaultPlugins`) run beside them.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const KIT = readFileSync(path.join(REPO_ROOT, '.github/workflows/kit.yml'), 'utf8')

/** The text of one job: from `  <id>:` to the next two-space key. */
function job(id: string): string {
  const lines = KIT.split('\n')
  const start = lines.indexOf(`  ${id}:`)
  expect(start, `job ${id}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^ {0,2}[\w-]+:/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

describe('kit.yml', () => {
  it('runs on pull requests and pushes to main, and is never a deploy precondition', () => {
    expect(KIT).toMatch(/\non:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/)
    expect(KIT).not.toMatch(/workflow_call/)
    const deploy = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).not.toMatch(/uses: \.\/\.github\/workflows\/kit\.yml/)
  })

  it('kit-checks: the porting note, the published plugin API, the plugin audit, defaultPlugins', () => {
    const checks = job('kit-checks')
    expect(checks).toContain('node scripts/release-check.mjs --unreleased')
    expect(checks).toMatch(
      /node scripts\/plugin-api-doc\.mjs\n\s+git diff --exit-code -- docs\/plugin-api\.md/
    )
    expect(checks).toContain('node scripts/plugin.mjs check')
    expect(checks).toContain('node scripts/default-plugins.mjs --github-output')
  })

  it('kit-checks and renamed: the Launch kit check, on the kit and on the renamed copy (D36)', () => {
    expect(job('kit-checks')).toContain('node scripts/kit-check.mjs --exec')
    const renamed = job('renamed')
    // After the rename, so it checks the COPY: its names, its manifest's kit block.
    expect(renamed.indexOf('node scripts/kit-check.mjs --exec')).toBeGreaterThan(
      renamed.indexOf('node scripts/rename.mjs my-app')
    )
  })

  it('renamed: renames to a hyphenated slug, proves the kit-only files are gone, runs pnpm gate', () => {
    const renamed = job('renamed')
    expect(renamed).toContain('node scripts/rename.mjs my-app')
    for (const file of ['kit.yml', 'plugin-ci.yml', 'notify-plugins.yml']) {
      expect(renamed).toContain(`.github/workflows/${file}`)
    }
    expect(renamed).toMatch(/- run: pnpm gate\s*$/)
  })

  it('plugins: installs the defaults, then the whole suite under neon', () => {
    const plugins = job('plugins')
    expect(plugins).toContain("needs.kit-checks.outputs.count != '0'")
    expect(plugins).toMatch(/- run: pnpm gate\n\s+env:\n\s+GATE_SUITE_DRIVER: neon/)
  })

  it('never skips a gate step', () => {
    expect(KIT).not.toMatch(/pnpm gate[^\n]*--skip/)
  })

  it('is kitOnly, with the other two workflows a copy has no use for', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
    expect(manifest.kitOnly).toEqual(
      expect.arrayContaining([
        '.github/workflows/kit.yml',
        '.github/workflows/plugin-ci.yml',
        '.github/workflows/notify-plugins.yml',
      ])
    )
  })
})
