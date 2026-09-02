/**
 * `scripts/provision/patch-toml.ts` — string-level patching of the wrangler tomls (config project,
 * no database). Runs against the REAL staging/production toml text on disk so a drift in the
 * files' shape shows up here, and re-checks the parity test's own invariants on the patched pair.
 */
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import {
  patchToml,
  readTomlString,
  TomlPatchError,
  tomlPlaceholders,
} from '../../scripts/provision/patch-toml'

const WEB_DIR = path.resolve(__dirname, '../..')
/**
 * The tomls on disk may be provisioned already (real ids, an active `routes` line) — this test
 * must pass in both states, so it normalises the disk text back to the shipped shape and proves
 * the patcher round-trips through it.
 */
function unprovision(text: string, env: 'staging' | 'production'): string {
  const tag = env === 'staging' ? '_STAGING' : ''
  return text
    .replace(
      /(binding = "HYPERDRIVE"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/,
      `$1<HYPERDRIVE${tag}_ID>$2`
    )
    .replace(
      /(binding = "RATE_LIMIT_KV"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/,
      `$1<KV_RATE_LIMIT${tag}_ID>$2`
    )
    .replace(/^routes = \[/m, '# routes = [')
}
const stagingText = unprovision(
  fs.readFileSync(path.join(WEB_DIR, 'wrangler.staging.toml'), 'utf8'),
  'staging'
)
const prodText = unprovision(
  fs.readFileSync(path.join(WEB_DIR, 'wrangler.toml'), 'utf8'),
  'production'
)

// Obviously fake 32-hex ids (the real ones are also 32 hex — that is what the parity test expects).
const HD_STAGING = '0123456789abcdef0123456789abcdef'
const KV_STAGING = 'fedcba9876543210fedcba9876543210'
const HD_PROD = '11111111111111111111111111111111'
const KV_PROD = '22222222222222222222222222222222'

const commentLines = (text: string) => text.split('\n').filter(l => /^\s*#/.test(l))

describe('patch-toml: the shipped tomls (normalised) carry the placeholders this patcher targets', () => {
  it('staging and production have their four placeholders', () => {
    expect(tomlPlaceholders(stagingText)).toEqual([
      '<HYPERDRIVE_STAGING_ID>',
      '<KV_RATE_LIMIT_STAGING_ID>',
    ])
    expect(tomlPlaceholders(prodText)).toEqual(['<HYPERDRIVE_ID>', '<KV_RATE_LIMIT_ID>'])
  })
  it('round-trips: unprovision(patchToml(text)) === text', () => {
    const patched = patchToml(stagingText, {
      hyperdriveId: HD_STAGING,
      kvId: KV_STAGING,
      routeHost: 'staging.example.test',
    })
    expect(unprovision(patched, 'staging')).not.toBe(patched)
    expect(TOML.parse(unprovision(patched, 'staging'))).toEqual(TOML.parse(stagingText))
    expect(tomlPlaceholders(unprovision(patched, 'staging'))).toEqual(tomlPlaceholders(stagingText))
  })
})

describe('patch-toml: ids', () => {
  it('replaces both placeholders in the staging toml and nothing else', () => {
    const out = patchToml(stagingText, { hyperdriveId: HD_STAGING, kvId: KV_STAGING })
    expect(tomlPlaceholders(out)).toEqual([])
    const doc = TOML.parse(out) as any
    expect(doc.hyperdrive[0].id).toBe(HD_STAGING)
    expect(doc.kv_namespaces[0].id).toBe(KV_STAGING)
    // localConnectionString and everything else is untouched.
    expect(doc.hyperdrive[0].localConnectionString).toBe(
      (TOML.parse(stagingText) as any).hyperdrive[0].localConnectionString
    )
    expect(out.split('\n').length).toBe(stagingText.split('\n').length)
    expect(commentLines(out)).toEqual(commentLines(stagingText))
  })

  it('is idempotent: a second run with the same ids is byte-identical', () => {
    const once = patchToml(stagingText, { hyperdriveId: HD_STAGING, kvId: KV_STAGING })
    const twice = patchToml(once, { hyperdriveId: HD_STAGING, kvId: KV_STAGING })
    expect(twice).toBe(once)
  })

  it('refuses to overwrite a DIFFERENT existing id unless force', () => {
    const once = patchToml(stagingText, { hyperdriveId: HD_STAGING, kvId: KV_STAGING })
    expect(() => patchToml(once, { hyperdriveId: HD_PROD })).toThrow(TomlPatchError)
    expect(() => patchToml(once, { kvId: KV_PROD })).toThrow(/already has id/)
    const forced = patchToml(once, { hyperdriveId: HD_PROD, force: true })
    expect((TOML.parse(forced) as any).hyperdrive[0].id).toBe(HD_PROD)
  })

  it('throws when the binding block is missing', () => {
    expect(() => patchToml('name = "x"\n', { hyperdriveId: HD_PROD })).toThrow(/no `id` line/)
  })
})

describe('patch-toml: vars and routes', () => {
  it('sets APP_URL and EMAIL_FROM, keeping the trailing comment', () => {
    const out = patchToml(prodText, {
      appUrl: 'https://app.example.test',
      emailFrom: 'Example <noreply@mail.example.test>',
    })
    const doc = TOML.parse(out) as any
    expect(doc.vars.APP_URL).toBe('https://app.example.test')
    expect(doc.vars.EMAIL_FROM).toBe('Example <noreply@mail.example.test>')
    expect(readTomlString(out, 'APP_URL')).toBe('https://app.example.test')
    const appUrlLine = out.split('\n').find(l => l.startsWith('APP_URL'))
    expect(appUrlLine).toMatch(/# public origin/)
    expect(commentLines(out)).toEqual(commentLines(prodText))
  })

  it('un-comments the routes line with the host, idempotently, and can re-point it', () => {
    const out = patchToml(prodText, { routeHost: 'app.example.test' })
    const doc = TOML.parse(out) as any
    expect(doc.routes).toEqual([{ pattern: 'app.example.test', custom_domain: true }])
    expect(patchToml(out, { routeHost: 'app.example.test' })).toBe(out)
    const moved = patchToml(out, { routeHost: 'www.example.test' })
    expect((TOML.parse(moved) as any).routes[0].pattern).toBe('www.example.test')
    // Exactly one comment line (the template) was consumed; every other comment survives.
    expect(commentLines(out).length).toBe(commentLines(prodText).length - 1)
  })

  it('inserts a workers_dev note after `name` only when no workers_dev line exists', () => {
    const noted = patchToml(prodText, {
      workersDevComment: 'workers_dev = true is the default: served at workers.dev',
    })
    expect(noted).toContain('name = "')
    expect(noted.split('\n')[noted.split('\n').findIndex(l => l.startsWith('name = ')) + 1]).toBe(
      '# workers_dev = true is the default: served at workers.dev'
    )
    expect(TOML.parse(noted)).toEqual(TOML.parse(prodText))
    // A second run finds the note (it starts with `workers_dev =`) and inserts nothing.
    expect(patchToml(noted, { workersDevComment: 'served at workers.dev' })).toBe(noted)
    // The staging toml already declares workers_dev = true → untouched.
    expect(patchToml(stagingText, { workersDevComment: 'x' })).toBe(stagingText)
  })
})

describe('patch-toml: the patched pair satisfies the parity test invariants', () => {
  const staging = TOML.parse(
    patchToml(stagingText, {
      hyperdriveId: HD_STAGING,
      kvId: KV_STAGING,
      appUrl: 'https://staging.example.test',
      routeHost: 'staging.example.test',
    })
  ) as any
  const prod = TOML.parse(
    patchToml(prodText, {
      hyperdriveId: HD_PROD,
      kvId: KV_PROD,
      appUrl: 'https://app.example.test',
      routeHost: 'app.example.test',
    })
  ) as any
  const strings = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) for (const x of v) strings(x, out)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
    return out
  }

  it('no <PLACEHOLDER> remains in either document', () => {
    for (const doc of [staging, prod])
      expect(strings(doc).filter(s => /^<[A-Z0-9_]+>$/.test(s))).toEqual([])
  })
  it('hyperdrive and KV ids differ between environments', () => {
    expect(staging.hyperdrive[0].id).not.toBe(prod.hyperdrive[0].id)
    expect(staging.kv_namespaces[0].id).not.toBe(prod.kv_namespaces[0].id)
  })
  it('[vars] keys are identical, APP_URL differs, bindings unchanged', () => {
    expect(Object.keys(staging.vars).sort()).toEqual(Object.keys(prod.vars).sort())
    expect(staging.vars.APP_URL).not.toBe(prod.vars.APP_URL)
    expect(staging.hyperdrive[0].binding).toBe(prod.hyperdrive[0].binding)
    expect(staging.kv_namespaces[0].binding).toBe(prod.kv_namespaces[0].binding)
    expect(staging.name).toBe(`${prod.name}-staging`)
    expect(staging.routes[0].pattern).not.toBe(prod.routes[0].pattern)
  })
})
