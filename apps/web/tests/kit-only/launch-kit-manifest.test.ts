/**
 * `launch.kit.json` — the Launch kit contract (D36, `docs/CONCEPTS.md` §13): THIS kit's manifest is
 * valid, and its VALUES match the code they name: the bootstrap parses the session's command and
 * reads its env names, the dev server reads its port names, the KV title map covers every KV
 * binding, the RLS role template names the role the migrations create. A manifest that parses but
 * points at the wrong flag is what this catches.
 *
 * Kit-only: it judges this checkout's own manifest and tomls, which a copy is free to change (and
 * Launch's write_config rewrites). The shape cases, on a fixture manifest, are
 * `launch-kit-schema.test.ts` beside it.
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

describe("this kit's launch.kit.json", () => {
  it('is valid', () => {
    expect(problems).toEqual([])
    expect(m.schema).toBe(1)
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

  it('declaredConfig: every plain name is an optional name', () => {
    expect(m.declaredConfig.plain.length).toBeGreaterThan(0)
    expect(m.declaredConfig.optional).toEqual(expect.arrayContaining(m.declaredConfig.plain))
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
