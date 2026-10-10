/**
 * `launch.kit.json` — the Launch kit contract (D36, `docs/CONCEPTS.md` §13): what this kit calls
 * things and how Launch drives it. Two halves:
 *
 * - the shape, through `scripts/lib/kit-manifest.mjs` — the plain-JS mirror of Launch's zod schema
 *   (`@launch/shared/kit-manifest`), shared with the meta-kit (its `scripts/tests/manifest.test.mjs`
 *   is ported here);
 * - the VALUES, against the code they name: the bootstrap parses the session's command and reads
 *   its env names, the dev server reads its port names, the KV title map covers every KV binding,
 *   the RLS role template names the role the migrations create. A manifest that parses but points
 *   at the wrong flag is what this half catches.
 *
 * It travels into every copy (a copy keeps the manifest; the rename rewrites everything but its
 * `kit` block), so no assertion here spells a kit token: the kit's own names come from
 * `rename-lib.mjs`'s `KIT`, which the rename never touches. The `config` project: no database.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ROLE } from '@/db/schema/rls'
import {
  BOOTSTRAP_SKIPPABLE_STEPS,
  parseBootstrapArgs,
} from '../../../../scripts/lib/bootstrap-lib.mjs'
import { resolveDevAllowedHosts, resolveDevPorts } from '../../../../scripts/lib/dev-ports.mjs'
import {
  fillTemplate,
  type KitManifest,
  validateManifest,
} from '../../../../scripts/lib/kit-manifest.mjs'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'
import { KIT, parseArgs as parseRenameArgs } from '../../../../scripts/lib/rename-lib.mjs'
import { parseToml } from '../../../../scripts/lib/toml-lite.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const own = (): KitManifest => JSON.parse(read('launch.kit.json'))
const { manifest: parsed, problems } = validateManifest(own())
const m = parsed as KitManifest
const provenance = readManifest(REPO_ROOT).manifest

/** A command template's words after `node <file>`, with its placeholders filled. */
const argvOf = (template: string, values: Record<string, string>) =>
  fillTemplate(template, values).split(/\s+/).slice(2)

describe('launch.kit.json (the shape Launch parses)', () => {
  it("this checkout's manifest is valid", () => {
    expect(problems).toEqual([])
    expect(m.schema).toBe(1)
  })

  it('applies the same defaults as Launch', () => {
    const raw = own()
    delete raw.health
    delete raw.kit.version
    delete raw.worker.naming
    delete raw.declaredConfig
    const { manifest } = validateManifest(raw)
    expect(manifest?.health).toEqual({ live: '/api/health', ready: '/api/ready' })
    expect(manifest?.kit.version).toEqual({ file: 'package.json', field: 'version' })
    expect(manifest?.worker.naming).toEqual({
      pattern: '{slug}-{suffix}',
      stagingSuffix: '-staging',
    })
    expect(manifest?.declaredConfig).toEqual({ optional: [] })
  })

  it('tolerates unknown fields', () => {
    const raw = own()
    raw.future = { anything: true }
    raw.kit.extra = 'x'
    expect(validateManifest(raw).problems).toEqual([])
  })

  /** `[what, dotted path, value (undefined deletes it), the problem it must name]` */
  const refusals: [string, string, unknown, string][] = [
    ['a schema other than 1', 'schema', 2, 'schema: must be 1'],
    ['a bad kit id', 'kit.id', 'Bad_Id', 'kit.id'],
    ['an empty kit repo', 'kit.repo', ' ', 'kit.repo'],
    ['a missing appManifest', 'scaffold.appManifest', undefined, 'scaffold.appManifest: required'],
    ['an absolute path', 'worker.tomls.staging', '/etc/x.toml', 'worker.tomls.staging'],
    ['a parent path', 'scaffold.appManifest', '../x.json', 'scaffold.appManifest'],
    ['an uppercase KV title', 'worker.titles', { KV: 'Rate' }, 'worker.titles'],
    ['a lowercase env name', 'launchProvides.appUrl', 'app_url', 'launchProvides.appUrl'],
    [
      'a generated secret of another kind',
      'launchProvides.generated',
      [{ name: 'X', kind: 'uuid' }],
      'launchProvides.generated',
    ],
    ['roles as an array', 'database.roles', ['migrator', 'app'], 'database.roles'],
    ['deployer protocol 2', 'release.deployerProtocol', 2, 'release.deployerProtocol'],
    ['a workflow path', 'release.workflow', '.github/workflows/deploy.yml', 'release.workflow'],
    ['another naming pattern', 'worker.naming.pattern', '{suffix}-{slug}', 'worker.naming.pattern'],
    ['a health path without /', 'health.ready', 'api/ready', 'health.ready'],
    ['a missing session block', 'session', undefined, 'session: required'],
  ]
  for (const [what, at, value, expected] of refusals) {
    it(`refuses ${what}`, () => {
      const raw = own()
      const keys = at.split('.')
      const last = keys.pop() as string
      const parent = keys.reduce((o, k) => o[k], raw)
      if (value === undefined) delete parent[last]
      else parent[last] = value
      const result = validateManifest(raw)
      expect(result.manifest).toBeNull()
      expect(
        result.problems.some(p => p.includes(expected)),
        result.problems.join('\n')
      ).toBe(true)
    })
  }

  it('fillTemplate substitutes and refuses an unknown placeholder', () => {
    expect(fillTemplate('pnpm gate {step}', { step: 'lint' })).toBe('pnpm gate lint')
    expect(() => fillTemplate('x {nope}', {})).toThrow(/Unknown placeholder/)
  })
})

describe('launch.kit.json says what this kit really does', () => {
  it('kit: names the kit, in the kit and in every copy (the rename keeps the block)', () => {
    expect(m.kit.id).toBe(KIT.slug)
    expect(m.kit.name).toBe(KIT.display)
    expect(m.kit.repo).toBe(provenance?.kit.repo)
    expect(provenance?.kit.id).toBe(m.kit.id)
    expect(m.scaffold.appManifest).toBe('.rocketflare.json')
  })

  it('scaffold: the init is the rename, its flags parse, and kitOnly is the provenance list', () => {
    // One-word values: Launch shell-quotes each one, this split does not.
    const argv = argvOf(m.scaffold.init, { slug: 'my-app', display: 'Acme', domain: 'example.com' })
    expect(m.scaffold.init.startsWith('node scripts/rename.mjs ')).toBe(true)
    expect(parseRenameArgs(argv)).toMatchObject({
      slug: 'my-app',
      display: 'Acme',
      domain: 'example.com',
      force: true,
      skipInstall: true,
    })
    expect(m.scaffold.kitOnly).toEqual(provenance?.kitOnly)
  })

  it('worker: every KV title names a KV binding of both tomls', () => {
    // A binding with no entry gets Launch's derived title; the kit's own KV is not derived
    // (`RATE_LIMIT_KV` is created as `<slug>-rate-limit`), so the map must name it.
    expect(Object.keys(m.worker.titles ?? {}).length).toBeGreaterThan(0)
    for (const env of ['production', 'staging'] as const) {
      const toml = parseToml(read(m.worker.tomls[env]))
      const kv = (toml.kv_namespaces ?? []).map((k: { binding: string }) => k.binding)
      expect(kv).toEqual(expect.arrayContaining(Object.keys(m.worker.titles ?? {})))
    }
  })

  it('launchProvides: the fixed vars are vars both tomls already declare', () => {
    for (const env of ['production', 'staging'] as const) {
      const vars = parseToml(read(m.worker.tomls[env])).vars ?? {}
      for (const name of Object.keys(m.launchProvides.vars)) expect(vars).toHaveProperty(name)
      expect(vars).toHaveProperty(m.launchProvides.appUrl)
      expect(vars).toHaveProperty(m.launchProvides.databaseDriver.name)
    }
  })

  it('database: the RLS role template names the role the migrations create', () => {
    const snake = (provenance?.app?.slug ?? KIT.slug).replaceAll('-', '_')
    expect(fillTemplate(m.database.rlsRole, { slug_snake: snake })).toBe(APP_ROLE)
  })

  it('session: the bootstrap command parses, with the env names it reads', () => {
    const argv = argvOf(m.session.bootstrap, {
      dbUrl: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/app',
    })
    const opts = parseBootstrapArgs(argv, {
      [m.session.env.skip]: BOOTSTRAP_SKIPPABLE_STEPS[0],
      [m.session.env.allowRoot]: '1',
    })
    expect(opts).toMatchObject({
      dbUrl: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/app',
      driver: 'neon',
      offline: true,
      dev: false,
      plugins: false,
      open: false,
      yes: true,
      allowRoot: true,
    })
    expect(opts.skip).toEqual([BOOTSTRAP_SKIPPABLE_STEPS[0]])
  })

  it('session: the dev server reads the port names Launch sets', () => {
    const { ports } = m.session
    expect(resolveDevPorts({ [ports.ui]: '5173', [ports.api]: '8787' })).toEqual({
      ui: 5173,
      api: 8787,
    })
    expect(resolveDevAllowedHosts({ [ports.allowedHosts]: '.example.test' })).toEqual([
      '.example.test',
    ])
    expect(m.session.devStart).toBe('node apps/web/scripts/dev-server.mjs --start')
  })

  it('ci: the gate test runner reads the test-env names', () => {
    const plan = read('scripts/lib/test-plan.mjs')
    expect(plan).toContain(m.ci.testEnv.branch)
    expect(plan).toContain(m.ci.testEnv.endpoint)
  })
})
