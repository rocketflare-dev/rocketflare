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

/**
 * The kit's own placeholders. A copy with a plugin installed (D31) carries that plugin's KV
 * placeholder too, so the assertions below name what they are about instead of demanding the
 * document hold nothing else.
 */
const kitPlaceholders = (env: 'staging' | 'production') =>
  env === 'staging'
    ? ['<HYPERDRIVE_STAGING_ID>', '<KV_RATE_LIMIT_STAGING_ID>']
    : ['<HYPERDRIVE_ID>', '<KV_RATE_LIMIT_ID>']
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
    expect(tomlPlaceholders(stagingText)).toEqual(
      expect.arrayContaining(kitPlaceholders('staging'))
    )
    expect(tomlPlaceholders(prodText)).toEqual(
      expect.arrayContaining(kitPlaceholders('production'))
    )
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
    for (const p of kitPlaceholders('staging')) expect(tomlPlaceholders(out)).not.toContain(p)
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

  it('no KIT <PLACEHOLDER> remains in either document', () => {
    for (const [env, doc] of [
      ['staging', staging],
      ['production', prod],
    ] as const) {
      const left = strings(doc).filter(x => /^<[A-Z0-9_]+>$/.test(x))
      for (const p of kitPlaceholders(env)) expect(left).not.toContain(p)
    }
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

// ---- plugin blocks and list appends (D31, Decision 12) ------------------------------------

/**
 * These four ops are what `pnpm provision cloudflare <env>` uses to write a plugin's `plugin.json`
 * declarations into BOTH tomls. Every one of them has to be idempotent, because the phase is
 * re-runnable by design and a second block for one binding is a toml wrangler accepts and nobody
 * can reason about; and every one of them has to keep the document parseable, which is what the
 * TOML.parse assertions below are for.
 */
describe('plugin binding blocks', () => {
  const fixtureBlocks = [
    {
      type: 'kv' as const,
      binding: 'TOMLFIXTURE_CACHE',
      id: '<KV_TOMLFIXTURE_CACHE_ID>',
      pluginId: 'tomlfixture',
    },
    {
      type: 'queue' as const,
      binding: 'TOMLFIXTURE_QUEUE',
      name: 'acme-tomlfixture-jobs',
      consumer: true,
      pluginId: 'tomlfixture',
    },
    {
      type: 'r2' as const,
      binding: 'TOMLFIXTURE_FILES',
      name: 'acme-tomlfixture-files',
      pluginId: 'tomlfixture',
    },
  ]
  const patched = patchToml(prodText, { bindings: fixtureBlocks })
  const doc = TOML.parse(patched) as any

  const baseline = TOML.parse(prodText) as any

  it('inserts exactly one block per binding, in the right section, after what was there', () => {
    for (const [section, binding] of [
      ['kv_namespaces', 'TOMLFIXTURE_CACHE'],
      ['queues.producers', 'TOMLFIXTURE_QUEUE'],
      ['r2_buckets', 'TOMLFIXTURE_FILES'],
    ] as const) {
      const rows = (o: any) =>
        section.split('.').reduce((acc: any, k) => acc?.[k], o) as Array<{ binding: string }>
      expect(rows(doc)).toHaveLength(rows(baseline).length + 1)
      expect(rows(doc).at(-1)?.binding).toBe(binding)
    }
  })

  it('a queue with `consumer` also gets a [[queues.consumers]] block', () => {
    expect(doc.queues.consumers).toHaveLength(baseline.queues.consumers.length + 1)
    const added = doc.queues.consumers.at(-1)
    expect(added.queue).toBe('acme-tomlfixture-jobs')
    expect(added.max_retries).toBe(3)
  })

  it('leaves every kit binding and id untouched', () => {
    expect(doc.kv_namespaces[0]).toEqual(baseline.kv_namespaces[0])
    expect(doc.hyperdrive).toEqual(baseline.hyperdrive)
    expect(doc.workflows).toEqual(baseline.workflows)
  })

  it('is idempotent', () => {
    expect(patchToml(patched, { bindings: fixtureBlocks })).toBe(patched)
  })

  it('updates the id of a block that already declares the binding, rather than adding a second', () => {
    const provisioned = patchToml(patched, {
      bindings: [{ type: 'kv', binding: 'TOMLFIXTURE_CACHE', id: 'a'.repeat(32) }],
    })
    const after = TOML.parse(provisioned) as any
    expect(after.kv_namespaces).toHaveLength(baseline.kv_namespaces.length + 1)
    expect(after.kv_namespaces.at(-1).id).toBe('a'.repeat(32))
    expect(tomlPlaceholders(provisioned)).not.toContain('<KV_TOMLFIXTURE_CACHE_ID>')
  })

  it('refuses to overwrite a DIFFERENT real id unless forced', () => {
    const provisioned = patchToml(patched, {
      bindings: [{ type: 'kv', binding: 'TOMLFIXTURE_CACHE', id: 'a'.repeat(32) }],
    })
    const rival = { type: 'kv' as const, binding: 'TOMLFIXTURE_CACHE', id: 'b'.repeat(32) }
    expect(() => patchToml(provisioned, { bindings: [rival] })).toThrowError(TomlPatchError)
    const forced = patchToml(provisioned, { bindings: [rival], force: true })
    expect((TOML.parse(forced) as any).kv_namespaces.at(-1).id).toBe('b'.repeat(32))
  })

  it('refuses a block with no value to write', () => {
    expect(() => patchToml(prodText, { bindings: [{ type: 'r2', binding: 'X' }] })).toThrowError(
      TomlPatchError
    )
  })
})

describe('plugin crons, vars and run_worker_first', () => {
  const patch = {
    crons: ['7 3 * * *'],
    vars: [{ key: 'TOMLFIXTURE_MAX_ITEMS', value: '50' }],
    workerFirstPrefixes: ['/tomlfixture-hook'],
  }
  const patched = patchToml(prodText, patch)
  const doc = TOML.parse(patched) as any
  const before = TOML.parse(prodText) as any

  it('appends the cron without disturbing the kit’s two', () => {
    expect(doc.triggers.crons).toEqual([...before.triggers.crons, '7 3 * * *'])
  })

  it('appends the [vars] key, and does not move or rewrite an existing one', () => {
    expect(doc.vars.TOMLFIXTURE_MAX_ITEMS).toBe('50')
    expect(doc.vars.APP_ENV).toBe(before.vars.APP_ENV)
    expect(Object.keys(doc.vars)).toEqual([...Object.keys(before.vars), 'TOMLFIXTURE_MAX_ITEMS'])
  })

  it('appends both run_worker_first patterns — the prefix and everything beneath it', () => {
    expect(doc.assets.run_worker_first).toEqual([
      ...before.assets.run_worker_first,
      '/tomlfixture-hook',
      '/tomlfixture-hook/*',
    ])
  })

  it('is idempotent, and never rewrites a [vars] value the operator set', () => {
    expect(patchToml(patched, patch)).toBe(patched)
    const renamed = patchToml(patched, {
      vars: [{ key: 'TOMLFIXTURE_MAX_ITEMS', value: '999' }],
    })
    expect((TOML.parse(renamed) as any).vars.TOMLFIXTURE_MAX_ITEMS).toBe('50')
  })

  it('throws when the array it was asked to append to does not exist', () => {
    expect(() => patchToml('name = "x"\n', { crons: ['0 0 * * *'] })).toThrowError(TomlPatchError)
  })
})

/**
 * Class bindings (D31). A `workflow` and a `durable_object` need no resource created — the block
 * IS the registration and `wrangler deploy` does the rest — so what matters here is that the
 * blocks are spelled the way Cloudflare reads them, and that re-running provisioning is a no-op.
 */
describe('plugin workflow and Durable Object blocks', () => {
  const blocks = [
    {
      type: 'workflow' as const,
      binding: 'ORDERS_SYNC',
      name: 'acme-orders-sync',
      className: 'OrdersSyncWorkflow',
      pluginId: 'orders',
    },
    {
      type: 'durable_object' as const,
      binding: 'ORDERS_HUB',
      className: 'OrdersHub',
      pluginId: 'orders',
    },
  ]
  const migrations = [
    { tag: 'plugin-orders-v1', newSqliteClasses: ['OrdersHub'], pluginId: 'orders' },
  ]
  const baseline = TOML.parse(prodText) as any
  const patched = patchToml(prodText, { bindings: blocks, migrations })
  const doc = TOML.parse(patched) as any

  it('adds the workflow beside the kit’s, keeping binding and class_name', () => {
    expect(doc.workflows).toHaveLength(baseline.workflows.length + 1)
    expect(doc.workflows.at(-1)).toEqual({
      name: 'acme-orders-sync',
      binding: 'ORDERS_SYNC',
      class_name: 'OrdersSyncWorkflow',
    })
  })

  it('spells a Durable Object binding as `name`, which is how the toml names one', () => {
    // Not `binding`: the kit's own is `name = "NOTIFICATIONS_HUB"`. A patcher keyed on `binding`
    // would never find an existing block and would insert a second one on every run.
    expect(doc.durable_objects.bindings).toHaveLength(baseline.durable_objects.bindings.length + 1)
    expect(doc.durable_objects.bindings.at(-1)).toEqual({
      name: 'ORDERS_HUB',
      class_name: 'OrdersHub',
    })
  })

  it('appends the migration tag and never touches the kit’s', () => {
    expect(doc.migrations).toHaveLength(baseline.migrations.length + 1)
    expect(doc.migrations[0]).toEqual(baseline.migrations[0])
    expect(doc.migrations.at(-1)).toEqual({
      tag: 'plugin-orders-v1',
      new_sqlite_classes: ['OrdersHub'],
    })
  })

  it('is idempotent, and never rewrites a tag Cloudflare has already applied', () => {
    expect(patchToml(patched, { bindings: blocks, migrations })).toBe(patched)
    // A tag is an identity, not a value: re-running with different classes under the SAME tag
    // leaves the recorded one alone, because replaying it loses the namespace it created.
    const rival = patchToml(patched, {
      migrations: [{ tag: 'plugin-orders-v1', newClasses: ['SomethingElse'] }],
    })
    expect((TOML.parse(rival) as any).migrations.at(-1)).toEqual({
      tag: 'plugin-orders-v1',
      new_sqlite_classes: ['OrdersHub'],
    })
  })

  it('refuses to rename a live Workflow, and renames one block rather than adding a second', () => {
    // Each toml is patched from its own baseline, so the production file only ever sees the
    // production name — a DIFFERENT name arriving means the app was renamed, and a Workflow name
    // is account-scoped state with instances under it. Same protection the KV id has, same escape.
    const renamed = { ...blocks[0], name: 'acme-orders-sync-staging' }
    expect(() => patchToml(patched, { bindings: [renamed] })).toThrowError(TomlPatchError)
    const forced = patchToml(patched, { bindings: [renamed], force: true })
    const after = TOML.parse(forced) as any
    expect(after.workflows).toHaveLength(baseline.workflows.length + 1)
    expect(after.workflows.at(-1).name).toBe('acme-orders-sync-staging')
    // and the kit's own Workflow is untouched by any of it
    expect(after.workflows[0]).toEqual(baseline.workflows[0])
  })

  it('refuses a class binding with no class to name', () => {
    expect(() =>
      patchToml(prodText, { bindings: [{ type: 'durable_object', binding: 'X' }] })
    ).toThrowError(TomlPatchError)
  })
})
