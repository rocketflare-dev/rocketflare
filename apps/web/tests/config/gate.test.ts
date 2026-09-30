/**
 * `pnpm gate` and `pnpm test` (docs/CONCEPTS.md §4): the step list is the contract Launch reads,
 * and the test plan is what makes the driver seam hold in every copy — the `driver` project runs
 * under BOTH drivers on a local target, and the remote target is decided by an explicit variable,
 * never by the shape of a URL.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gateListSchema } from '@rocketflare/shared/gate'
import { describe, expect, it } from 'vitest'
import { GATE_STEPS, gateList, parseGateArgs } from '../../../../scripts/lib/gate-lib.mjs'
import type { TestPlan } from '../../../../scripts/lib/test-plan.d.mts'
import { PROXY_URL, planTests, resolveTarget } from '../../../../scripts/lib/test-plan.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const GATE_BRANCH = {
  DATABASE_URL: 'postgresql://o:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db',
  TEST_DATABASE_BRANCH: 'gate-ab12cd-1',
  TEST_DATABASE_ENDPOINT: 'ep-cool-name-123456',
}

function plan(env: Record<string, string | undefined>, kitOnly = false): TestPlan {
  const p = planTests(env, { kitOnly })
  if ('error' in p) throw new Error(p.error)
  return p
}

/** The web vitest steps as `projects @ driver`, the shape the seam depends on. */
function webRuns(p: TestPlan): string[] {
  return p.steps
    .filter(s => s.command.includes('vitest'))
    .map(s => {
      const projects = s.command.flatMap((a, i) => (s.command[i - 1] === '--project' ? [a] : []))
      return `${projects.join('+')} @ ${s.env.DATABASE_DRIVER}`
    })
}

describe('pnpm gate', () => {
  it('lists lint → typecheck → test → build, in the shape the shared schema parses', () => {
    const list = gateListSchema.parse(gateList())
    expect(list.steps.map(s => s.id)).toEqual(['lint', 'typecheck', 'test', 'build'])
    expect(list.steps.filter(s => s.database).map(s => s.id)).toEqual(['test'])
    expect(GATE_STEPS.find(s => s.id === 'test')?.command).toEqual(['pnpm', 'test'])
  })

  it('has no step for generated files (the four owners live elsewhere)', () => {
    expect(GATE_STEPS.map(s => s.id)).not.toContain('generated')
  })

  it('parses steps, --skip and --keep-going, and keeps gate order', () => {
    expect(parseGateArgs([])).toEqual({
      list: false,
      json: false,
      keepGoing: false,
      steps: ['lint', 'typecheck', 'test', 'build'],
    })
    expect(parseGateArgs(['build', 'lint'])).toMatchObject({ steps: ['lint', 'build'] })
    expect(parseGateArgs(['--skip', 'test', '--skip=build'])).toMatchObject({
      steps: ['lint', 'typecheck'],
    })
    expect(parseGateArgs(['--keep-going'])).toMatchObject({ keepGoing: true })
    expect(parseGateArgs(['--list', '--json'])).toMatchObject({ list: true, json: true })
    expect(parseGateArgs(['--help'])).toEqual({ help: true })
  })

  it('refuses what it cannot mean', () => {
    expect(parseGateArgs(['generated'])).toMatchObject({
      error: expect.stringMatching(/unknown step/),
    })
    expect(parseGateArgs(['--skip'])).toMatchObject({ error: expect.stringMatching(/--skip/) })
    expect(parseGateArgs(['--json'])).toMatchObject({ error: expect.stringMatching(/--list/) })
    expect(parseGateArgs(['--list', 'test'])).toMatchObject({ error: expect.any(String) })
    expect(parseGateArgs(['test', '--skip', 'test'])).toMatchObject({
      error: 'nothing left to run',
    })
    expect(parseGateArgs(['--fast'])).toMatchObject({
      error: expect.stringMatching(/unknown option/),
    })
  })

  it('is wired: the root scripts run the gate and the test runner', () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts
    expect(scripts.gate).toBe('node scripts/gate.mjs')
    expect(scripts.test).toBe('node scripts/test.mjs')
    // One test command: the profiles it replaced are gone, with no aliases.
    expect(scripts['test:neon']).toBeUndefined()
    expect(scripts['test:ephemeral']).toBeUndefined()
    expect(scripts['test:gate']).toBeUndefined()
    const web = JSON.parse(readFileSync(path.join(REPO, 'apps/web/package.json'), 'utf8')).scripts
    // The gate's `typecheck` step owns the typecheck; `build` does not repeat it.
    expect(web.build).not.toMatch(/typecheck/)
  })
})

describe('pnpm test: the target', () => {
  it('is local by default, remote only when TEST_DATABASE_BRANCH names a branch', () => {
    expect(resolveTarget({})).toEqual({ target: 'local', suiteDriver: 'postgres' })
    expect(resolveTarget(GATE_BRANCH)).toEqual({ target: 'remote', suiteDriver: 'neon' })
    // A remote-looking URL alone is NOT a remote target: the local guard refuses it instead.
    expect(resolveTarget({ DATABASE_URL: GATE_BRANCH.DATABASE_URL })).toMatchObject({
      target: 'local',
    })
  })

  it('refuses conflicting signals rather than guessing', () => {
    expect(resolveTarget({ TEST_DATABASE_EPHEMERAL: '1' })).toMatchObject({
      error: expect.stringMatching(/without TEST_DATABASE_BRANCH/),
    })
    expect(resolveTarget({ ...GATE_BRANCH, GATE_SUITE_DRIVER: 'postgres' })).toMatchObject({
      error: expect.stringMatching(/cannot run on a remote target/),
    })
    expect(resolveTarget({ GATE_SUITE_DRIVER: 'mysql' })).toMatchObject({
      error: expect.stringMatching(/neon or postgres/),
    })
  })
})

describe('pnpm test: the plan', () => {
  it('local: the suite under postgres, then the driver project under neon through the proxy', () => {
    const p = plan({})
    expect(p.compose).toBe(true)
    expect(p.steps[0]?.command).toEqual(['pnpm', '-r', '--filter', '!./apps/web', 'test'])
    expect(webRuns(p)).toEqual([
      'api @ postgres',
      'api-isolated+driver+ui+config @ postgres',
      'driver @ neon',
    ])
    expect(p.steps.at(-1)?.env.NEON_LOCAL_PROXY).toBe(PROXY_URL)
    expect(p.steps[1]?.command).toContain('--no-isolate')
  })

  it('the conformance pass is pinned: the driver project runs under BOTH drivers locally', () => {
    for (const env of [{}, { GATE_SUITE_DRIVER: 'neon' }, { GATE_SUITE_DRIVER: 'postgres' }]) {
      const drivers = webRuns(plan(env))
        .filter(r => r.split(' @ ')[0]?.split('+').includes('driver'))
        .map(r => r.split(' @ ')[1])
      expect(new Set(drivers)).toEqual(new Set(['postgres', 'neon']))
    }
  })

  it('GATE_SUITE_DRIVER=neon: the suite under neon, the conformance pass under postgres', () => {
    expect(webRuns(plan({ GATE_SUITE_DRIVER: 'neon' }))).toEqual([
      'api @ neon',
      'api-isolated+driver+ui+config @ neon',
      'driver @ postgres',
    ])
  })

  it('remote: no Docker, the whole suite under neon, and the skipped half said out loud', () => {
    const p = plan(GATE_BRANCH)
    expect(p.compose).toBe(false)
    expect(p.banner).toMatch(/gate-ab12cd-1/)
    expect(webRuns(p)).toEqual(['api @ neon', 'api-isolated+driver+ui+config @ neon'])
    for (const step of p.steps.filter(s => s.command.includes('vitest'))) {
      expect(step.env).toMatchObject({ TEST_DATABASE_EPHEMERAL: '1', APP_DATABASE_URL: '' })
      expect(step.env.NEON_LOCAL_PROXY).toBeUndefined()
      // The branch's own DATABASE_URL stands: the plan never sets one.
      expect(step.env.DATABASE_URL).toBeUndefined()
    }
    expect(p.notes.join('\n')).toMatch(/skipped — remote target, no TCP/)
  })

  it('names the kit-only project only when the checkout carries it', () => {
    expect(webRuns(plan({}, true))[1]).toBe('api-isolated+driver+ui+config+kit-only @ postgres')
    expect(webRuns(plan({}, false)).join('\n')).not.toMatch(/kit-only/)
    expect(existsSync(path.join(REPO, 'scripts/test.mjs'))).toBe(true)
  })
})
