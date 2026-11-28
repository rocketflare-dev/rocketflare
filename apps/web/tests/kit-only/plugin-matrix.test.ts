/**
 * The plugin matrix (#180): `scripts/plugin-matrix.mjs` (what runs, what failed, the summary),
 * the workflow that drives it, and `kit:release`'s dispatch-wait-report. Kit-only: a copy has
 * neither the workflow nor the release script. The `kit-only` project: no database, no network —
 * the release half runs against a scripted `gh`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildResult,
  countWarnings,
  FULL_HOUSE,
  failingStep,
  installOrder,
  jobVerdicts,
  latestPlugins,
  type MatrixResult,
  matrixEntries,
  missingResults,
  newestReleases,
  newestTag,
  type PublishedPlugin,
  parseFailures,
  parseReleaseTag,
  pluginsFromTree,
  readPlugins,
  STEP_NAMES,
  summaryTable,
} from '../../../../scripts/plugin-matrix.mjs'
import {
  awaitPluginMatrix,
  dispatchPluginMatrix,
  pluginMatrixLines,
  type ToolResult,
} from '../../../../scripts/release.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github/workflows/plugin-matrix.yml'), 'utf8')

const plugin = (id: string, requires: string[] = []): PublishedPlugin => ({
  id,
  version: '3.14.0',
  subdir: `plugins/${id}`,
  requires,
})
const PLUGINS = [plugin('analytics'), plugin('connectors'), plugin('m365', ['connectors'])]

describe('installOrder / matrixEntries', () => {
  it('installs a requirement before the plugin that needs it', () => {
    expect(installOrder(PLUGINS, ['m365']).map(p => p.id)).toEqual(['connectors', 'm365'])
  })

  it('refuses a cycle and an unpublished requirement, naming the plugin', () => {
    expect(() => installOrder([plugin('a', ['b']), plugin('b', ['a'])], ['a'])).toThrow(
      'requires.plugins forms a cycle: a -> b -> a'
    )
    expect(() => installOrder([plugin('a', ['ghost'])], ['a'])).toThrow(
      "a requires plugin 'ghost', which the plugins repository does not publish"
    )
    expect(() => installOrder(PLUGINS, ['nope'])).toThrow("'nope' is not a published plugin")
  })

  it('is one entry per plugin plus a full house holding every plugin, whatever was selected', () => {
    const entries = matrixEntries(PLUGINS, { only: ['m365'] })
    expect(entries).toEqual([
      {
        id: 'm365',
        version: '3.14.0',
        installs: 'connectors=plugins/connectors m365=plugins/m365',
        refs: '',
      },
      {
        id: FULL_HOUSE,
        version: '3 plugins',
        installs: 'analytics=plugins/analytics connectors=plugins/connectors m365=plugins/m365',
        refs: '',
      },
    ])
    expect(matrixEntries(PLUGINS, { fullHouse: false }).map(e => e.id)).toEqual([
      'analytics',
      'connectors',
      'm365',
    ])
  })
})

describe('readPlugins / newestTag', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads every manifest in the checkout, with its requirements by id', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'matrix-'))
    const write = (sub: string, manifest: object) => {
      mkdirSync(path.join(dir, sub), { recursive: true })
      writeFileSync(path.join(dir, sub, 'rocketflare-plugin.json'), JSON.stringify(manifest))
    }
    write('plugins/b', { id: 'b', version: '1.0.0', requires: { plugins: [{ id: 'a' }] } })
    write('plugins/a', { id: 'a', version: '1.0.0' })
    write('plugins/a/node_modules/x', { id: 'x' })
    expect(readPlugins(dir)).toEqual([
      { id: 'a', version: '1.0.0', subdir: 'plugins/a', requires: [] },
      { id: 'b', version: '1.0.0', subdir: 'plugins/b', requires: ['a'] },
    ])
  })

  it('takes the last bare X.Y.Z tag of a version-sorted ls-remote', () => {
    const lsRemote = ['abc\trefs/tags/3.9.0', 'def\trefs/tags/3.14.0', 'fed\trefs/tags/v4-rc'].join(
      '\n'
    )
    expect(newestTag(lsRemote)).toBe('3.14.0')
    expect(newestTag('')).toBeNull()
  })
})

describe('per-plugin tags (#181)', () => {
  const TAGS = ['3.13.0', '3.14.0', 'analytics-v3.15.0', 'analytics-v3.14.1', 'guide-v3.14.0']
  const at = (tag: string, version: string, ids = ['analytics', 'connectors', 'guide']) =>
    ids.map(id => ({ ...plugin(id), version, tag }))

  it('reads both tag forms and nothing else', () => {
    expect(parseReleaseTag('3.14.0')).toEqual({ id: null, version: '3.14.0' })
    expect(parseReleaseTag('global-search-v3.15.0')).toEqual({
      id: 'global-search',
      version: '3.15.0',
    })
    for (const t of ['v3.14.0', 'analytics@3.15.0', 'analytics-3.15.0', 'main', '3.14'])
      expect(parseReleaseTag(t)).toBeNull()
  })

  it("takes each plugin's own tag when it is at least as new as the lockstep one", () => {
    const { lockstep, own } = newestReleases(TAGS)
    expect(lockstep).toBe('3.14.0')
    // guide's own 3.14.0 ties the lockstep 3.14.0 and wins the tie.
    expect([...own]).toEqual([
      ['analytics', 'analytics-v3.15.0'],
      ['guide', 'guide-v3.14.0'],
    ])
    // An older own tag loses to the lockstep tag that holds the plugin…
    expect(newestReleases(['3.14.0', 'sso-v1.0.0']).own.size).toBe(0)
    // …and is the plugin's release when the lockstep tag does not hold it.
    expect([...newestReleases(['3.14.0', 'sso-v1.0.0'], { inLockstep: () => false }).own]).toEqual([
      ['sso', 'sso-v1.0.0'],
    ])
  })

  it('resolves every plugin to its latest release, with the ref it installs from', () => {
    const readAt = (tag: string) =>
      tag === '3.14.0'
        ? at(tag, '3.14.0')
        : tag.startsWith('analytics-')
          ? at(tag, '3.15.0', ['analytics', 'connectors'])
          : tag.startsWith('guide-')
            ? at(tag, '3.14.0')
            : at(tag, '1.0.0', ['analytics', 'connectors', 'guide', 'sso'])
    const { lockstep, plugins } = latestPlugins([...TAGS, 'sso-v1.0.0'], readAt)
    expect(lockstep).toBe('3.14.0')
    expect(plugins.map(p => [p.id, p.version, p.ref])).toEqual([
      ['analytics', '3.15.0', 'analytics-v3.15.0'],
      ['connectors', '3.14.0', '3.14.0'],
      ['guide', '3.14.0', 'guide-v3.14.0'],
      ['sso', '1.0.0', 'sso-v1.0.0'],
    ])
    const [entry] = matrixEntries(plugins, { only: ['analytics'], fullHouse: false })
    expect(entry.refs).toBe('analytics=analytics-v3.15.0')
    // Lockstep only: every plugin at the one tag, exactly as before.
    expect(latestPlugins(['3.13.0', '3.14.0'], readAt).plugins.map(p => p.ref)).toEqual([
      '3.14.0',
      '3.14.0',
      '3.14.0',
    ])
  })

  it('reads a tree from a file list as readPlugins reads a checkout', () => {
    const tree: Record<string, string> = {
      'plugins/a/rocketflare-plugin.json': JSON.stringify({ id: 'a', version: '1.0.0' }),
      'plugins/a/node_modules/x/rocketflare-plugin.json': JSON.stringify({ id: 'x' }),
      '.github/rocketflare-plugin.json': JSON.stringify({ id: 'hidden' }),
    }
    expect(pluginsFromTree(Object.keys(tree), f => tree[f])).toEqual([
      { id: 'a', version: '1.0.0', subdir: 'plugins/a', requires: [] },
    ])
  })

  it('the workflow installs each plugin at its own ref, else plugins_ref', () => {
    expect(WORKFLOW).toMatch(/REFS: \$\{\{ matrix\.refs \}\}/)
    expect(WORKFLOW).toContain('pnpm plugin add "$PLUGINS_REPO@$ref"')
  })
})

describe('what failed', () => {
  const LOG = [
    '\u001b[31m FAIL \u001b[39m |api| src/plugins/x/tests/api/x.test.ts > x > isolates tenants 120ms',
    ' FAIL  |config| tests/config/plugins.test.ts > plugins > registers',
    'apps/web/src/plugins/x/server.ts(12,3): error TS2322: Type string is not assignable',
    '✖ pnpm gate failed: typecheck, test',
  ].join('\n')

  it('names the gate steps, the failing tests and type errors, without lines or timings', () => {
    expect(parseFailures(LOG)).toEqual({
      gateSteps: ['typecheck', 'test'],
      tests: [
        '|api| src/plugins/x/tests/api/x.test.ts > x > isolates tenants',
        '|config| tests/config/plugins.test.ts > plugins > registers',
        'apps/web/src/plugins/x/server.ts TS2322',
      ],
    })
  })

  it('is the first failed step in run order, the gate with its own failing steps', () => {
    expect(
      failingStep({ gate: { outcome: 'failure' }, check: { outcome: 'success' } }, ['test'])
    ).toBe(`${STEP_NAMES.gate} (test)`)
    expect(failingStep({ install: { outcome: 'failure' }, gate: { outcome: 'skipped' } })).toBe(
      STEP_NAMES.install
    )
    expect(failingStep({ gate: { outcome: 'success' } })).toBeNull()
  })

  it('counts value-check warnings per plugin, all of them for the full house, n/a without a report', () => {
    const check = JSON.stringify({
      ok: true,
      warnings: [{ id: 'm365:egress:tool' }, { id: 'analytics:title' }, { id: 'm365:x' }],
    })
    expect(countWarnings(check, 'm365')).toBe(2)
    expect(countWarnings(check, FULL_HOUSE)).toBe(3)
    expect(countWarnings(null, 'm365')).toBeNull()
    expect(countWarnings('usage: …', 'm365')).toBeNull()
  })

  it('builds a result: failure with its step and tests, success with none, unknown when nothing ran', () => {
    const base = { id: 'x', version: '1.0.0', kitRef: 'main', kitSha: 'a'.repeat(40), runUrl: 'u' }
    const red = buildResult({ ...base, steps: { gate: { outcome: 'failure' } }, log: LOG })
    expect(red).toMatchObject({ outcome: 'failure', step: `${STEP_NAMES.gate} (typecheck, test)` })
    expect(red.tests).toHaveLength(3)
    expect(
      buildResult({ ...base, steps: { gate: { outcome: 'success' } }, log: LOG })
    ).toMatchObject({ outcome: 'success', step: null, tests: [] })
    expect(buildResult({ ...base, steps: {} }).outcome).toBe('unknown')
  })
})

describe('the summary', () => {
  const result = (
    id: string,
    outcome: MatrixResult['outcome'],
    step: string | null = null
  ): MatrixResult => ({
    id,
    version: '3.14.0',
    kitRef: 'main',
    kitSha: 'abcdef0123456789',
    runUrl: 'u',
    outcome,
    step,
    tests: step ? ['t > fails'] : [],
    warnings: outcome === 'success' ? 0 : null,
  })

  it('is one row per plugin, failures first, with the step, warnings and kit sha', () => {
    const table = summaryTable([
      result('a', 'success'),
      result('b', 'failure', 'The kit gate (test)'),
    ])
    expect(table).toContain('kit `main` (`abcdef012345`): 1 of 2 green.')
    const rows = table.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Plugin'))
    expect(rows).toEqual([
      '| b | 3.14.0 | ✖ fail | The kit gate (test) | n/a | `abcdef012345` |',
      '| a | 3.14.0 | ✔ pass |  | 0 | `abcdef012345` |',
    ])
    expect(table).toContain('- `t > fails`')
  })

  it('adds a row for an expected job that recorded nothing', () => {
    const missing = missingResults(
      [{ id: 'a' }, { id: 'b', version: '3.14.0' }],
      [result('a', 'success')]
    )
    expect(missing).toMatchObject([{ id: 'b', outcome: 'unknown', kitSha: 'abcdef0123456789' }])
  })
})

describe('the workflow', () => {
  it('names every step the script reads back, under the same id', () => {
    for (const [id, name] of Object.entries(STEP_NAMES)) {
      const block = new RegExp(
        `- id: ${id}\\n\\s+name: '?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\n`
      )
      expect(WORKFLOW, id).toMatch(block)
    }
  })

  it('runs on a kit tag, on dispatch and as a reusable workflow, one `matrix <id>` job each', () => {
    expect(WORKFLOW).toMatch(/push:\n\s+tags: \['\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/)
    expect(WORKFLOW).toContain('workflow_dispatch:')
    expect(WORKFLOW).toContain('workflow_call:')
    expect(WORKFLOW).toContain(`name: matrix ${'${{'} matrix.id }}`)
    expect(WORKFLOW).toContain('fail-fast: false')
    // release.mjs finds its run by this.
    expect(WORKFLOW).toMatch(/run-name: >-\n.*inputs\.request_id/)
  })

  it("proves the pushed tag only on the kit's own push, never a calling repository's tag", () => {
    const pushGuards = WORKFLOW.split('\n').filter(l => l.includes("github.event_name == 'push'"))
    expect(pushGuards.length).toBeGreaterThan(0)
    for (const line of pushGuards) {
      expect(line).toContain(
        "github.repository == 'rocketflare-dev/rocketflare' && github.event_name == 'push'"
      )
    }
  })

  it('reports through the run alone: it never writes an issue', () => {
    expect(WORKFLOW).not.toMatch(/issues:\s*write|gh issue|gh api .*issues/)
    expect(WORKFLOW).toMatch(/^permissions:\n\s+contents: read\n/m)
  })

  it('is kitOnly, with its script, and notify-plugins.yml is gone', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
    expect(manifest.kitOnly).toEqual(
      expect.arrayContaining([
        '.github/workflows/plugin-matrix.yml',
        'scripts/plugin-matrix.mjs',
        'scripts/plugin-matrix.d.mts',
      ])
    )
    expect(manifest.kitOnly).not.toContain('.github/workflows/notify-plugins.yml')
  })
})

describe('jobVerdicts', () => {
  it('reads each matrix job (a caller prefix allowed) with its first failed step', () => {
    const jobs = [
      { name: 'Resolve the kit ref and the plugins', conclusion: 'success' },
      { name: 'matrix analytics', conclusion: 'success', steps: [] },
      {
        name: 'ci / matrix m365',
        conclusion: 'failure',
        url: 'https://x/job/1',
        steps: [
          { name: 'Install the plugin(s) into the kit', conclusion: 'success' },
          { name: 'The kit gate', conclusion: 'failure' },
        ],
      },
      { name: 'Summary', conclusion: 'success' },
    ]
    expect(jobVerdicts(jobs)).toEqual([
      { plugin: 'analytics', ok: true, conclusion: 'success', step: null, url: null },
      {
        plugin: 'm365',
        ok: false,
        conclusion: 'failure',
        step: 'The kit gate',
        url: 'https://x/job/1',
      },
    ])
  })
})

describe('kit:release and the matrix', () => {
  const SHA = 'a'.repeat(40)
  /** A scripted `gh`/`git`: each call is matched by its first arguments. */
  function runner(answers: Record<string, ToolResult | (() => ToolResult)>) {
    const calls: string[] = []
    const run = (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      const key = Object.keys(answers).find(k => line.startsWith(k))
      const answer = key ? answers[key] : undefined
      if (!answer) return { status: 1, stdout: '', stderr: `unscripted: ${line}` }
      return typeof answer === 'function' ? answer() : answer
    }
    return { run, calls }
  }
  const ok = (stdout = ''): ToolResult => ({ status: 0, stdout, stderr: '' })

  it('says it did not check when gh is missing, and never throws', () => {
    const { run } = runner({ 'gh --version': { status: -1, stdout: '', stderr: 'ENOENT' } })
    const handle = dispatchPluginMatrix({ version: '1.0.0', root: '.', run })
    expect(handle).toEqual({ skipped: 'gh is not installed' })
    expect(awaitPluginMatrix(handle, { run })).toEqual([
      '⚠ plugin matrix not checked: gh is not installed',
    ])
  })

  it('dispatches against origin/main with a request id, and notes unpushed commits', () => {
    const { run, calls } = runner({
      'gh --version': ok('gh 2'),
      'git ls-remote origin refs/heads/main': ok(`${SHA}\trefs/heads/main\n`),
      'git rev-parse HEAD': ok(`${'b'.repeat(40)}\n`),
      'gh workflow run': ok(),
    })
    const handle = dispatchPluginMatrix({ version: '1.0.0', root: '.', run, now: () => 42 })
    expect(handle).toEqual({ requestId: 'release-1.0.0-42', sha: SHA, unpushed: true })
    expect(calls).toContain(
      `gh workflow run plugin-matrix.yml --ref main -f kit_ref=${SHA} -f request_id=release-1.0.0-42`
    )
  })

  it('a refused dispatch is a reason, not a failure', () => {
    const { run } = runner({
      'gh --version': ok(),
      'git ls-remote': ok(`${SHA}\trefs/heads/main`),
      'git rev-parse': ok(SHA),
      'gh workflow run': { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible\n' },
    })
    expect(dispatchPluginMatrix({ version: '1.0.0', root: '.', run })).toEqual({
      skipped: 'gh workflow run failed: HTTP 403: Resource not accessible',
    })
  })

  const handle = { requestId: 'release-1.0.0-42', sha: SHA, unpushed: false }
  const runList = (status: string) =>
    ok(
      JSON.stringify([
        {
          databaseId: 7,
          displayTitle: 'Plugin matrix x [release-1.0.0-42]',
          status,
          url: 'https://run/7',
        },
      ])
    )

  it('waits for the run, then names each red plugin with its step', () => {
    let polls = 0
    const { run } = runner({
      'gh run list': () => runList(++polls < 3 ? 'in_progress' : 'completed'),
      'gh run view 7': ok(
        JSON.stringify({
          jobs: [
            { name: 'matrix a', conclusion: 'success', steps: [] },
            {
              name: 'matrix b',
              conclusion: 'failure',
              url: 'https://job/b',
              steps: [{ name: 'The kit gate', conclusion: 'failure' }],
            },
          ],
        })
      ),
    })
    let clock = 0
    const lines = awaitPluginMatrix(handle, { run, sleep: ms => (clock += ms), now: () => clock })
    expect(polls).toBe(3)
    expect(lines).toEqual(['⚠ b fails on main: The kit gate, https://job/b'])
  })

  it('gives up at the deadline with the run to watch', () => {
    const { run } = runner({ 'gh run list': runList('in_progress') })
    let clock = 0
    const lines = awaitPluginMatrix(handle, {
      run,
      sleep: ms => (clock += ms),
      now: () => clock,
      timeoutMs: 60_000,
    })
    expect(lines).toEqual(['⚠ plugin matrix still running: https://run/7 — gh run watch 7'])
  })

  it('prints one ✔ when every plugin is green', () => {
    expect(
      pluginMatrixLines(
        [
          { plugin: 'a', ok: true, conclusion: 'success', step: null, url: null },
          { plugin: FULL_HOUSE, ok: true, conclusion: 'success', step: null, url: null },
        ],
        'u'
      )
    ).toEqual(['✔ plugin matrix              a, full-house pass on main'])
  })
})
