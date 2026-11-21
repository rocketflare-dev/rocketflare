/**
 * `pnpm gate --changed` (scripts/lib/gate-changed.mjs): which paths force the full gate, which
 * packages a change reaches, and which web test files run. The rule under test everywhere: when
 * the selection cannot see a dependency, it runs more, never less.
 */
import { describe, expect, it } from 'vitest'
import {
  affectedPackages,
  declaredInputs,
  globToRegExp,
  planChanged,
  readsFiles,
  selectTests,
} from '../../../../scripts/lib/gate-changed.mjs'
import { parseGateArgs } from '../../../../scripts/lib/gate-lib.mjs'
import { planSelectedTests } from '../../../../scripts/lib/test-plan.mjs'

const PACKAGES = [
  { dir: 'apps/cli', name: '@k/cli', deps: ['@k/shared'], scripts: ['build', 'typecheck', 'test'] },
  { dir: 'apps/evals', name: '@k/evals', deps: ['@k/shared'], scripts: ['typecheck', 'test'] },
  { dir: 'apps/web', name: '@k/web', deps: ['@k/shared'], scripts: ['build', 'typecheck', 'test'] },
  {
    dir: 'packages/shared',
    name: '@k/shared',
    deps: [],
    scripts: ['build', 'typecheck', 'test'],
  },
]

const plan = (changed: string[]) => planChanged({ changed, existing: changed, packages: PACKAGES })

describe('globs', () => {
  it('** spans segments (zero included), * stays inside one', () => {
    expect(globToRegExp('**/package.json').test('package.json')).toBe(true)
    expect(globToRegExp('**/package.json').test('apps/web/package.json')).toBe(true)
    expect(globToRegExp('apps/*/vitest*.config.ts').test('apps/web/vitest.config.ts')).toBe(true)
    expect(globToRegExp('apps/*/x.ts').test('apps/web/src/x.ts')).toBe(false)
    expect(globToRegExp('scripts/**').test('scripts/lib/a.mjs')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})

describe('the full-gate triggers', () => {
  it.each([
    'pnpm-lock.yaml',
    'apps/web/package.json',
    'apps/web/tsconfig.json',
    'biome.json',
    'apps/web/vitest.config.ts',
    'apps/web/wrangler.staging.toml',
    'apps/web/migrations/0042_x.sql',
    'apps/web/tests/helpers/db.ts',
    'apps/web/tests/setup.ts',
    'scripts/lib/gate-changed.mjs',
    'scripts/test.mjs',
  ])('%s runs the full gate', file => {
    expect(plan(['apps/web/src/x.ts', file])).toEqual({ full: `${file} changed` })
  })

  it('an ordinary source file does not', () => {
    expect(plan(['apps/web/src/api/routes/x.ts'])).not.toHaveProperty('full')
  })
})

describe('the packages a change reaches', () => {
  it('shared reaches every package that depends on it', () => {
    expect(affectedPackages(['packages/shared/src/errors.ts'], PACKAGES)).toEqual([
      'apps/cli',
      'apps/evals',
      'apps/web',
      'packages/shared',
    ])
  })

  it('web reaches the eval kit too, through its alias — an edge package.json does not carry', () => {
    expect(affectedPackages(['apps/web/src/x.ts'], PACKAGES)).toEqual(['apps/evals', 'apps/web'])
  })

  it('the cli reaches only itself; root scripts are compiled by web', () => {
    expect(affectedPackages(['apps/cli/src/cli.ts'], PACKAGES)).toEqual(['apps/cli'])
    expect(affectedPackages(['scripts/plugin.mjs'], PACKAGES)).toEqual(['apps/evals', 'apps/web'])
  })

  it('docs reach no package', () => {
    expect(affectedPackages(['docs/CONCEPTS.md', 'CLAUDE.md'], PACKAGES)).toEqual([])
  })
})

describe('the steps over a change', () => {
  it('lints exactly the files still on disk', () => {
    const p = planChanged({
      changed: ['apps/web/src/a.ts', 'apps/web/src/gone.ts'],
      existing: ['apps/web/src/a.ts'],
      packages: PACKAGES,
    })
    expect(p).toMatchObject({ lint: ['apps/web/src/a.ts'] })
  })

  it('a test-only change typechecks and tests, and builds nothing', () => {
    expect(plan(['apps/web/tests/api/x.test.ts'])).toMatchObject({
      typecheck: ['apps/evals', 'apps/web'],
      build: [],
    })
  })

  it('a source change builds the package and its dependents', () => {
    expect(plan(['packages/shared/src/errors.ts'])).toMatchObject({
      build: ['apps/cli', 'apps/web', 'packages/shared'],
    })
    expect(plan(['apps/web/src/ui/App.tsx'])).toMatchObject({ build: ['apps/web'] })
  })

  it('a docs-only change still runs the web selection — the repository guards live there', () => {
    expect(plan(['docs/CONCEPTS.md'])).toMatchObject({
      typecheck: [],
      build: [],
      test: { web: true, packages: [] },
    })
  })
})

describe('which web tests run', () => {
  const FS = "import { readFileSync } from 'node:fs'\n"
  const all = [
    { file: 'apps/web/tests/api/a.test.ts', project: 'api' },
    { file: 'apps/web/tests/api/b.test.ts', project: 'api' },
    { file: 'apps/web/tests/config/guard.test.ts', project: 'config' },
    { file: 'apps/web/tests/kit-only/tool.test.ts', project: 'kit-only' },
    { file: 'apps/web/tests/config/helper-user.test.ts', project: 'config' },
  ]
  const sources = {
    'apps/web/tests/api/a.test.ts': "import x from '@/a'\n",
    'apps/web/tests/api/b.test.ts': "import y from '@/b'\n",
    'apps/web/tests/config/guard.test.ts': `/** Scans src. */\n${FS}`,
    'apps/web/tests/kit-only/tool.test.ts': `/**\n * Runs the tool.\n * @gate-inputs scripts/** .rocketflare.json\n */\n${FS}`,
    'apps/web/tests/config/helper-user.test.ts':
      "import { sourceFiles } from '../helpers/source-files'\n",
  }
  const select = (changed: string[], related: typeof all = []) =>
    selectTests({ all, related, sources, changed, fsHelpers: ['helpers/source-files'] })

  it("runs vitest's import-graph answer", () => {
    const related = [{ file: 'apps/web/tests/api/a.test.ts', project: 'api' }]
    expect(select(['apps/web/src/a.ts'], related).api).toEqual(['apps/web/tests/api/a.test.ts'])
  })

  it('always runs a test that reads files and declares no inputs, directly or through a helper', () => {
    const chosen = select(['apps/web/src/a.ts'])
    expect(chosen.config).toEqual([
      'apps/web/tests/config/guard.test.ts',
      'apps/web/tests/config/helper-user.test.ts',
    ])
  })

  it('runs a test with declared inputs only when one of them changed', () => {
    expect(select(['apps/web/src/a.ts'])['kit-only']).toBeUndefined()
    expect(select(['scripts/plugin.mjs'])['kit-only']).toEqual([
      'apps/web/tests/kit-only/tool.test.ts',
    ])
    expect(select(['.rocketflare.json'])['kit-only']).toHaveLength(1)
  })

  it('runs a changed test file even when nothing imports it', () => {
    expect(select(['apps/web/tests/api/b.test.ts']).api).toEqual(['apps/web/tests/api/b.test.ts'])
  })

  it('reads the declared inputs across lines and closing comments', () => {
    expect(declaredInputs('/**\n * @gate-inputs a/** b\n * @gate-inputs c */\n')).toEqual([
      'a/**',
      'b',
      'c',
    ])
    expect(declaredInputs('// nothing\n')).toBeNull()
    expect(readsFiles("import { spawnSync } from 'node:child_process'")).toBe(true)
    expect(readsFiles("import path from 'node:path'")).toBe(false)
  })
})

describe('pnpm test --changed: the plan', () => {
  const runs = (p: ReturnType<typeof planSelectedTests>) => {
    if ('error' in p) throw new Error(p.error)
    return p
  }

  it('starts no database when no chosen file needs one', () => {
    const p = runs(
      planSelectedTests({}, { projects: { ui: ['/w/tests/ui/a.test.tsx'] }, packages: [] })
    )
    expect(p.compose).toBe(false)
    expect(p.steps.map(s => s.label)).toEqual(['web: ui, 1 file(s) under postgres'])
  })

  it('keeps api on the shared registry, and the driver files under both drivers', () => {
    const p = runs(
      planSelectedTests(
        {},
        { projects: { api: ['/w/a.test.ts'], driver: ['/w/d.test.ts'] }, packages: ['apps/cli'] }
      )
    )
    expect(p.compose).toBe(true)
    expect(p.steps.map(s => s.env.DATABASE_DRIVER ?? '-')).toEqual([
      '-',
      'postgres',
      'postgres',
      'neon',
    ])
    expect(p.steps[1]?.command).toContain('--no-isolate')
    expect(p.steps[0]?.command).toEqual(['pnpm', '--filter', './apps/cli', 'test'])
  })
})

describe('pnpm gate --changed: the flag', () => {
  it('is null for the full gate, empty for the default base, the ref when named', () => {
    expect(parseGateArgs([])).toMatchObject({ changed: null })
    expect(parseGateArgs(['--changed'])).toMatchObject({ changed: '' })
    expect(parseGateArgs(['--changed=HEAD~2', 'test'])).toMatchObject({
      changed: 'HEAD~2',
      steps: ['test'],
    })
    expect(parseGateArgs(['--changed='])).toMatchObject({ error: expect.any(String) })
    expect(parseGateArgs(['--list', '--changed'])).toMatchObject({ error: expect.any(String) })
  })
})
