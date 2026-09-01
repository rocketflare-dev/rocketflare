/**
 * wrangler.toml ⇄ wrangler.staging.toml parity.
 *
 * The kit deploys two standalone Worker configs (D6): `[env.*]` does not inherit bindings, so the
 * two files are copies that must differ ONLY in name, routes, `[vars]` values and resource ids.
 * Everything application code can observe — binding names, DO class names, compatibility date
 * and flags, `[limits]`, crons, `[assets]` — must be identical, or a Worker behaves differently
 * in staging and production. Account-scoped resource names (Workflow `name`, queue `queue`, R2
 * `bucket_name`) must additionally DIFFER, because the last deployer of a shared Workflow name
 * owns it and runs the other environment's instances under its own bindings.
 *
 * Placeholder check: `<HYPERDRIVE_ID>`-style tokens are allowed while the kit is unprovisioned, so
 * PR CI (`ci.yml`) stays green on a fresh copy. The deploy workflow sets `REQUIRE_PROVISIONED=1`
 * before its test step and the placeholder `describe` runs only then. See docs/DEPLOY.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'

type Toml = Record<string, unknown>
type Row = Record<string, unknown>

const ROOT = path.resolve(__dirname, '../..')
const read = (file: string): Toml =>
  TOML.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as Toml

const prod = read('wrangler.toml')
const staging = read('wrangler.staging.toml')

// ---- helpers ----------------------------------------------------------------------------

const get = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Row)[key]
    return undefined
  }, obj)

const rows = (obj: Toml, dotted: string): Row[] => {
  const v = get(obj, dotted)
  return Array.isArray(v) ? (v as Row[]) : []
}

/** Sorted projection of an array-of-tables section, keeping only environment-invariant keys. */
const shape = (obj: Toml, section: string, keys: string[]): Row[] =>
  rows(obj, section)
    .map(r => Object.fromEntries(keys.map(k => [k, r[k]])))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

const names = (obj: Toml, section: string, key: string): string[] =>
  rows(obj, section)
    .map(r => String(r[key]))
    .sort()

/** Every string value in the parsed document (comments are gone after parsing). */
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

const PLACEHOLDER = /^<[A-Z0-9_]+>$/

// Sections whose *binding names + class names* must match. `keys` are the environment-invariant
// fields (what code sees); `scopedKey` is the account-scoped resource name that must differ.
const BINDING_SECTIONS: Array<{ section: string; keys: string[]; scopedKey?: string }> = [
  { section: 'kv_namespaces', keys: ['binding'] },
  { section: 'hyperdrive', keys: ['binding'] },
  { section: 'queues.producers', keys: ['binding'], scopedKey: 'queue' },
  {
    section: 'queues.consumers',
    keys: ['max_batch_size', 'max_batch_timeout', 'max_retries', 'retry_delay'],
    scopedKey: 'queue',
  },
  { section: 'durable_objects.bindings', keys: ['name', 'class_name'] },
  { section: 'workflows', keys: ['binding', 'class_name'], scopedKey: 'name' },
  { section: 'r2_buckets', keys: ['binding'], scopedKey: 'bucket_name' },
  { section: 'analytics_engine_datasets', keys: ['binding'], scopedKey: 'dataset' },
]

// ---- must match -------------------------------------------------------------------------

describe('wrangler parity: must match', () => {
  it.each([
    'main',
    'compatibility_date',
    'compatibility_flags',
    'limits',
    'placement',
    'observability',
    'assets',
  ])('top-level `%s` is identical', key => {
    expect(staging[key]).toEqual(prod[key])
  })

  it('[triggers].crons are identical', () => {
    expect(get(staging, 'triggers.crons')).toEqual(get(prod, 'triggers.crons'))
  })

  it('[vars] declare the same KEYS (values may differ)', () => {
    const keys = (o: Toml) => Object.keys((o.vars as Row) ?? {}).sort()
    expect(keys(staging)).toEqual(keys(prod))
  })

  it('[vars].APP_ENV is production / staging respectively', () => {
    expect(get(prod, 'vars.APP_ENV')).toBe('production')
    expect(get(staging, 'vars.APP_ENV')).toBe('staging')
  })

  it.each(BINDING_SECTIONS)('$section: same binding names and classes', ({ section, keys }) => {
    expect(shape(staging, section, keys)).toEqual(shape(prod, section, keys))
  })

  it('[ai] binding (when present) is identical', () => {
    expect(get(staging, 'ai.binding')).toEqual(get(prod, 'ai.binding'))
  })

  it('[[migrations]] (Durable Object class migrations) are identical', () => {
    expect(staging.migrations).toEqual(prod.migrations)
  })

  it('every Durable Object class_name is identical and in-script (no script_name)', () => {
    const cls = (o: Toml) => names(o, 'durable_objects.bindings', 'class_name')
    expect(cls(staging)).toEqual(cls(prod))
    for (const r of [
      ...rows(prod, 'durable_objects.bindings'),
      ...rows(staging, 'durable_objects.bindings'),
    ]) {
      expect(
        r.script_name,
        'DO hub lives in this worker; a cross-script binding is a different design'
      ).toBeUndefined()
    }
  })

  it('both files declare the baseline bindings', () => {
    expect(names(prod, 'hyperdrive', 'binding')).toContain('HYPERDRIVE')
    expect(names(prod, 'kv_namespaces', 'binding')).toContain('RATE_LIMIT_KV')
    expect(get(prod, 'assets.binding')).toBe('ASSETS')
    expect(prod.compatibility_flags).toContain('nodejs_compat')
  })
})

// ---- must differ ------------------------------------------------------------------------

describe('wrangler parity: must differ', () => {
  it('staging name = production name + "-staging"', () => {
    expect(staging.name).toBe(`${prod.name}-staging`)
  })

  it('every account-scoped resource name in staging ends with -staging and differs from production', () => {
    for (const { section, scopedKey } of BINDING_SECTIONS) {
      if (!scopedKey) continue
      const p = names(prod, section, scopedKey)
      const s = names(staging, section, scopedKey)
      expect(s.length, `${section}: same number of entries`).toBe(p.length)
      for (const name of s) {
        expect(name, `${section}.${scopedKey}`).toMatch(/[-_]staging$/)
        expect(p, `${section}.${scopedKey} "${name}" is shared with production`).not.toContain(name)
      }
    }
  })

  it('resource ids differ between environments once provisioned', () => {
    // Skipped while placeholders remain (both files carry the same token shape but different text).
    for (const section of ['hyperdrive', 'kv_namespaces']) {
      const p = names(prod, section, 'id')
      const s = names(staging, section, 'id')
      for (const id of s) {
        if (PLACEHOLDER.test(id)) continue
        expect(p, `${section}.id "${id}" is shared with production`).not.toContain(id)
      }
    }
  })

  it('[vars].APP_URL differs', () => {
    expect(get(staging, 'vars.APP_URL')).not.toEqual(get(prod, 'vars.APP_URL'))
  })
})

// ---- provisioned ------------------------------------------------------------------------

describe.runIf(process.env.REQUIRE_PROVISIONED === '1')(
  'wrangler parity: provisioned (REQUIRE_PROVISIONED=1)',
  () => {
    it.each([
      ['wrangler.toml', prod],
      ['wrangler.staging.toml', staging],
    ])('%s contains no <PLACEHOLDER> values', (_file, doc) => {
      const left = strings(doc).filter(s => PLACEHOLDER.test(s))
      expect(left, 'run scripts/cf-provision.sh and paste the ids').toEqual([])
    })

    it('hyperdrive and KV ids differ between environments', () => {
      for (const section of ['hyperdrive', 'kv_namespaces']) {
        const p = new Set(names(prod, section, 'id'))
        for (const id of names(staging, section, 'id'))
          expect(p.has(id), `${section}.id shared`).toBe(false)
      }
    })
  }
)
