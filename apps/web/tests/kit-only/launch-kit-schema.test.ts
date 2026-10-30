/**
 * `launch.kit.json`'s shape, through `scripts/lib/kit-manifest.mjs` — the plain-JS mirror of
 * Launch's zod schema (`@launch/shared/kit-manifest`), shared with the meta-kit (its
 * `scripts/tests/manifest.test.mjs` is ported here).
 *
 * Judged on the fixture kit's manifest (`./fixtures/kit-fixture.mjs`, shared with the meta-kit),
 * never this checkout's. Kit-only: the validator is the kit's to keep in step with Launch, so a copy's
 * gate does not re-prove it. That THIS kit's manifest is valid and says what the kit really does is
 * `launch-kit-manifest.test.ts` beside it (and kit.yml's `Launch kit check`). No database.
 */
import { describe, expect, it } from 'vitest'
import {
  fillTemplate,
  type KitManifest,
  validateManifest,
} from '../../../../scripts/lib/kit-manifest.mjs'
import { fixtureManifest } from './fixtures/kit-fixture.mjs'

const own = (): KitManifest => fixtureManifest()

describe('launch.kit.json (the shape Launch parses)', () => {
  it("the fixture kit's manifest is valid", () => {
    const { problems, manifest } = validateManifest(own())
    expect(problems).toEqual([])
    expect(manifest?.schema).toBe(1)
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
    expect(manifest?.declaredConfig).toEqual({ optional: [], plain: [] })
  })

  it('accepts a base64-32 generated secret and declaredConfig.plain', () => {
    const raw = own()
    raw.launchProvides.generated = [{ name: 'X', kind: 'base64-32' }]
    raw.declaredConfig = { optional: ['A_KEY', 'A_URL'], plain: ['A_URL'] }
    const { problems: found, manifest } = validateManifest(raw)
    expect(found).toEqual([])
    expect(manifest?.launchProvides.generated[0].kind).toBe('base64-32')
    expect(manifest?.declaredConfig.plain).toEqual(['A_URL'])
  })

  it("defaults launchProvides.oidc's callbackPath and signedOutPath to Rocketflare's", () => {
    const { problems: found, manifest } = validateManifest(own())
    expect(found).toEqual([])
    expect(manifest?.launchProvides.oidc.callbackPath).toBe('/auth/oidc/callback')
    expect(manifest?.launchProvides.oidc.signedOutPath).toBe('/login?signedOut=1')
  })

  it('accepts a callbackPath and a signedOutPath on the app', () => {
    for (const [callbackPath, signedOutPath] of [
      ['/auth/callback', '/'],
      ['/auth/oidc/callback', '/login?signedOut=1'],
      ['/sso/return/', '/bye?from=sso&x=1'],
    ]) {
      const raw = own()
      Object.assign(raw.launchProvides.oidc, { callbackPath, signedOutPath })
      const { problems: found, manifest } = validateManifest(raw)
      expect(found, callbackPath).toEqual([])
      expect(manifest?.launchProvides.oidc.callbackPath).toBe(callbackPath)
      expect(manifest?.launchProvides.oidc.signedOutPath).toBe(signedOutPath)
    }
  })

  for (const bad of [
    '',
    'auth/callback',
    '//evil.example/auth/callback',
    'https://app.example.com/auth/callback',
    '/auth/call back',
    '/auth/callback\n',
    '/auth/callback#x',
    `/${'a'.repeat(300)}`,
    42,
  ]) {
    it(`refuses the OIDC path ${JSON.stringify(bad).slice(0, 40)}`, () => {
      for (const key of ['callbackPath', 'signedOutPath']) {
        const raw = own()
        raw.launchProvides.oidc[key] = bad
        const result = validateManifest(raw)
        expect(result.manifest, key).toBeNull()
        expect(
          result.problems.some(p => p.startsWith(`launchProvides.oidc.${key}:`)),
          result.problems.join('\n')
        ).toBe(true)
      }
    })
  }

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
    [
      'a plain name that is not an env name',
      'declaredConfig.plain',
      ['a_url'],
      'declaredConfig.plain',
    ],
    ['plain as a string', 'declaredConfig.plain', 'A_URL', 'declaredConfig.plain'],
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
