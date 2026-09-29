/**
 * `.github/workflows/plugin-ci.yml`'s resolve script — which kits a plugin is proved against, and
 * which of its sibling plugins are installed before it (D31, D34).
 *
 * The script lives INSIDE the workflow on purpose: plugin repositories call that file as `@main`
 * while cloning a RELEASED kit, so it cannot import anything from the kit's `scripts/` — an older
 * tag would not carry it. So this test runs the real thing: it lifts the heredoc out of the YAML,
 * writes it beside a fixture checkout exactly as the runner does, and executes it with node. A
 * restated copy of the logic here would prove the copy. The `config` project: no database.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github/workflows/plugin-ci.yml'), 'utf8')

/** The `resolve.mjs` heredoc, de-indented the way the YAML block scalar de-indents it. */
function resolveScript(): string {
  const lines = WORKFLOW.split('\n')
  const start = lines.findIndex(l => l.trim() === "cat > resolve.mjs <<'RESOLVE'")
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'RESOLVE')
  expect(start, 'the resolve heredoc opener').toBeGreaterThan(-1)
  expect(end, 'the resolve heredoc terminator').toBeGreaterThan(start)
  const indent = (lines[start] ?? '').match(/^ */)?.[0].length ?? 0
  return lines
    .slice(start + 1, end)
    .map(l => l.slice(indent))
    .join('\n')
}

interface Fixture {
  subdir: string
  manifest: Record<string, unknown>
}

interface Pair {
  kit: string
  plugin: string
  deps: string
  label: string
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(
  plugins: Fixture[],
  env: { subdirs: string[]; tags?: string[]; kitRef?: string }
): { status: number | null; stderr: string; pairs: Pair[] } {
  const work = mkdtempSync(path.join(tmpdir(), 'plugin-ci-'))
  dirs.push(work)
  for (const p of plugins) {
    mkdirSync(path.join(work, 'plugin', p.subdir), { recursive: true })
    writeFileSync(
      path.join(work, 'plugin', p.subdir, 'rocketflare-plugin.json'),
      JSON.stringify(p.manifest)
    )
  }
  const tags = env.tags ?? ['0.10.0', '0.11.0', '0.12.0']
  writeFileSync(path.join(work, 'kit-tags.txt'), `${tags.join('\n')}\n`)
  writeFileSync(path.join(work, 'resolve.mjs'), resolveScript())
  const output = path.join(work, 'github-output')
  writeFileSync(output, '')
  const result = spawnSync(process.execPath, ['resolve.mjs'], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: work,
      GITHUB_OUTPUT: output,
      KIT_CEILING: tags.at(-1) ?? '',
      KIT_REF: env.kitRef ?? '',
      PLUGIN_SUBDIRS: JSON.stringify(env.subdirs),
      // A deliberately bare environment: the runner's, not this process's (whose type is widened
      // by the Worker's env declaration).
    } as unknown as NodeJS.ProcessEnv,
  })
  const line = readFileSync(output, 'utf8')
    .split('\n')
    .find(l => l.startsWith('pairs='))
  return {
    status: result.status,
    stderr: result.stderr,
    pairs: line ? (JSON.parse(line.slice('pairs='.length)) as Pair[]) : [],
  }
}

const plugin = (id: string, minKit: string, requires?: unknown[]): Fixture => ({
  subdir: `plugins/${id}`,
  manifest: {
    id,
    version: '1.0.0',
    minKit,
    ...(requires ? { requires: { plugins: requires } } : {}),
  },
})

describe('plugin-ci resolve', () => {
  it('proves a plugin with no requirements at its floor and the newest kit, installing nothing first', () => {
    const { status, pairs } = run([plugin('analytics', '0.10.0')], {
      subdirs: ['plugins/analytics'],
    })
    expect(status).toBe(0)
    expect(pairs).toEqual([
      { kit: '0.10.0', plugin: 'plugins/analytics', deps: '', label: 'analytics' },
      { kit: '0.12.0', plugin: 'plugins/analytics', deps: '', label: 'analytics' },
    ])
  })

  it('installs required plugins first, dependencies before dependants, each once', () => {
    const { status, pairs } = run(
      [
        plugin('base', '0.10.0'),
        plugin('connectors', '0.10.0', ['base']),
        // Both a string and the object spelling, and a diamond onto `base`.
        plugin('m365', '0.10.0', [{ id: 'connectors', minVersion: '1.0.0' }, 'base']),
      ],
      { subdirs: ['plugins/m365'] }
    )
    expect(status).toBe(0)
    expect(pairs.map(p => p.deps)).toEqual([
      'plugins/base plugins/connectors',
      'plugins/base plugins/connectors',
    ])
  })

  it('takes the HIGHEST minKit across the plugin and what it requires as the floor', () => {
    const { status, pairs } = run(
      [plugin('connectors', '0.11.0'), plugin('m365', '0.10.0', ['connectors'])],
      { subdirs: ['plugins/m365'] }
    )
    expect(status).toBe(0)
    expect(pairs.map(p => p.kit)).toEqual(['0.11.0', '0.12.0'])
  })

  it('collapses to one kit when the effective floor is the newest release', () => {
    const { pairs } = run(
      [plugin('connectors', '0.12.0'), plugin('m365', '0.10.0', ['connectors'])],
      { subdirs: ['plugins/m365'] }
    )
    expect(pairs.map(p => p.kit)).toEqual(['0.12.0'])
  })

  it('resolves requirements under kit_ref too, without consulting any minKit', () => {
    const { status, pairs } = run(
      [plugin('connectors', '9.9.9'), plugin('m365', '9.9.9', ['connectors'])],
      { subdirs: ['plugins/m365'], kitRef: 'feat/x' }
    )
    expect(status).toBe(0)
    expect(pairs).toEqual([
      { kit: 'feat/x', plugin: 'plugins/m365', deps: 'plugins/connectors', label: 'm365' },
    ])
  })

  it('fails naming the id when a required plugin is not in the checkout', () => {
    const { status, stderr } = run([plugin('m365', '0.10.0', ['connectors'])], {
      subdirs: ['plugins/m365'],
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain("requires plugin 'connectors'")
  })

  it('refuses a requirement cycle', () => {
    const { status, stderr } = run([plugin('a', '0.10.0', ['b']), plugin('b', '0.10.0', ['a'])], {
      subdirs: ['plugins/a'],
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain('cycle')
  })

  it("fails on a required plugin's unreleased floor, naming that plugin", () => {
    const { status, stderr } = run(
      [plugin('connectors', '0.13.0'), plugin('m365', '0.10.0', ['connectors'])],
      { subdirs: ['plugins/m365'] }
    )
    expect(status).not.toBe(0)
    expect(stderr).toContain("connectors: minKit '0.13.0' is not a released kit version")
  })

  it('refuses two directories declaring one id', () => {
    const twin = { ...plugin('connectors', '0.10.0'), subdir: 'other/connectors' }
    const { status, stderr } = run([plugin('connectors', '0.10.0'), twin], {
      subdirs: ['plugins/connectors'],
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain("plugin id 'connectors' is declared twice")
  })

  it('passes the requirement list to the install step', () => {
    expect(WORKFLOW).toContain(`PLUGIN_DEPS: \${{ matrix.deps }}`)
    expect(WORKFLOW).toMatch(/for dep in \$PLUGIN_DEPS; do/)
  })
})
