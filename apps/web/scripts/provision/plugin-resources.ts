/**
 * What a plugin declares that the CLOUDFLARE account has to know about (D31, Decision 12).
 *
 * A plugin ships no toml — the two wrangler files are the host's, always (§16) — so everything it
 * needs from the platform is DECLARED in its `plugin.json` and applied by the host. Until this
 * file existed that meant a human editing both tomls by hand, which is exactly the class of job
 * that is forgotten in one of the two files and then behaves differently in staging.
 *
 * Four declarations, and the shapes are deliberately closed:
 *
 *   "bindings":    [{ "type": "kv" | "queue" | "r2", "binding": "APPROVALS_CACHE",
 *                     "name": "cache", "consumer": true }]
 *   "crons":       ["30 * * * *"]
 *   "apiPrefixes": ["/approvals-webhook"]
 *   "vars":        [{ "key": "APPROVALS_MAX_ITEMS", "example": "50", "secret": false }]
 *
 * `binding` is what the code reads off `Cloudflare.Env` and is IDENTICAL in both environments;
 * `name` is the account-scoped half and is suffixed per environment by `pluginResourceName` below.
 * A `var` marked `secret` is a Worker secret (`wrangler secret put`, offered by `provision secrets`)
 * and never a `[vars]` key; anything else is a `[vars]` key in BOTH tomls, because the parity test
 * compares the KEYS of that table.
 *
 * Pure except `readPluginResources`, which reads each installed plugin's anchor file.
 */
import fs from 'node:fs'
import path from 'node:path'
/**
 * The binding types provisioning knows how to write, and why the line falls where it does.
 *
 * Two groups. `kv`, `queue` and `r2` are CREATED — an account has to hold the resource before a
 * deploy, so `cf-provision.sh` finds-or-creates each one and the block carries its account-scoped
 * name (or, for KV, its id). `workflow` and `durable_object` are DECLARED only: `wrangler deploy`
 * registers both from the toml, so there is nothing to create and the block carries a `class_name`
 * instead.
 *
 * **Those two graduated because the sixth barrel exists** (D31). A `class_name` is resolved against
 * the named exports of the Worker's ENTRY module and nowhere else, so until
 * `apps/web/src/plugins/worker-exports.ts` made a plugin's class reachable from `src/worker.ts`
 * without anybody editing it, writing either block would have produced a toml pointing at a class
 * that was not exported — and `wrangler deploy` refuses the whole script for that, which is worse
 * than refusing the install. With the barrel, `plugin add` wires the class and `plugin check`
 * proves every name the manifest declares is really exported, so the block can be written.
 *
 * **`d1`, `vectorize`, `analytics_engine` and the rest have no such mechanism** and are refused BY
 * NAME rather than skipped, because a silently ignored binding is a plugin that deploys and then
 * 503s on its first request. What each of them would need is a way for the host to provide the
 * resource AND for the plugin's code to reach it, which for a stateful store is a design
 * conversation about migrations and tenancy rather than one more entry in a list.
 *
 * `hyperdrive` is deliberately refused for a different reason: it needs a connection string, it is
 * the host's one database, and the binding already exists — a plugin asking for its own is asking
 * for a second database.
 */
import {
  CLASS_PLUGIN_BINDING_TYPES,
  CREATED_PLUGIN_BINDING_TYPES,
  DO_STORAGE_KINDS,
  NAMED_PLUGIN_BINDING_TYPES,
  pluginMigrationTag,
  SUPPORTED_PLUGIN_BINDING_TYPES,
} from '../../../../scripts/lib/plugin-lib.mjs'
import type { BindingBlock, MigrationBlock } from './patch-toml'

/**
 * ONE list, owned by `scripts/lib/plugin-lib.mjs` so `pnpm plugin add` refuses an unsupported
 * type at INSTALL time and provisioning refuses the same one later; the `.d.mts` types it as the
 * literal tuple, which is what keeps `PluginBindingType` narrow here.
 */
export {
  CLASS_PLUGIN_BINDING_TYPES,
  CREATED_PLUGIN_BINDING_TYPES,
  DO_STORAGE_KINDS,
  NAMED_PLUGIN_BINDING_TYPES,
  pluginMigrationTag,
  SUPPORTED_PLUGIN_BINDING_TYPES,
}
export type PluginBindingType = (typeof SUPPORTED_PLUGIN_BINDING_TYPES)[number]
export type CreatedPluginBindingType = (typeof CREATED_PLUGIN_BINDING_TYPES)[number]
export type DoStorageKind = (typeof DO_STORAGE_KINDS)[number]

const isCreated = (type: PluginBindingType): type is CreatedPluginBindingType =>
  (CREATED_PLUGIN_BINDING_TYPES as readonly string[]).includes(type)
const isClassBinding = (type: PluginBindingType): boolean =>
  (CLASS_PLUGIN_BINDING_TYPES as readonly string[]).includes(type)
const isNamed = (type: PluginBindingType): boolean =>
  (NAMED_PLUGIN_BINDING_TYPES as readonly string[]).includes(type)

export type EnvName = 'staging' | 'production'

export interface PluginBinding {
  type: PluginBindingType
  /** The name on `Cloudflare.Env` — identical in both tomls. */
  binding: string
  /**
   * The account-scoped half; the full resource name is derived by `pluginResourceName`. Empty for
   * a `durable_object`, which has no account-scoped name at all: its block carries the BINDING as
   * its `name` and the class as `class_name`, identically in both files.
   */
  name: string
  /** `type: 'queue'` only: also emit a `[[queues.consumers]]` block. */
  consumer?: boolean
  /** `workflow` / `durable_object`: the class `plugins/worker-exports.ts` re-exports. */
  className?: string
  /** `durable_object` only: picks `new_sqlite_classes` over `new_classes`. Irreversible. */
  storage?: DoStorageKind
}

export interface PluginVar {
  key: string
  example?: string
  /** A Worker secret rather than a `[vars]` key. Default false. */
  secret?: boolean
}

/** One installed plugin's platform declarations, already validated. */
export interface PluginResources {
  id: string
  /** Where the declarations were read from, for an error message a human can act on. */
  anchor: string
  bindings: PluginBinding[]
  crons: string[]
  apiPrefixes: string[]
  vars: PluginVar[]
}

/** One resource for `cf-provision.sh` to find-or-create. */
export interface ResourceRecord {
  type: PluginBindingType | 'hyperdrive'
  /** The account-scoped resource name for ONE environment. */
  name: string
  binding: string
}

export class PluginResourceError extends Error {}

const BINDING_NAME = /^[A-Z][A-Z0-9_]*$/
const RESOURCE_NAME = /^[a-z][a-z0-9-]*$/
const VAR_KEY = /^[A-Z][A-Z0-9_]*$/
const CLASS_NAME = /^[A-Z][A-Za-z0-9_]*$/

/**
 * `<app>-<id>-<name>[-staging]` for the lowercase, hyphenated resources (queue, R2), and
 * `<APP>_<ID>_<NAME>[_STAGING]` for KV — which is not a whim: the kit's own KV namespace is
 * `<APP>_RATE_LIMIT[_STAGING]` and a plugin's should read like the rest of the account, not like
 * a different tool made it. The suffix is what the parity test's account-scoping rule checks.
 */
export function pluginResourceName(
  type: PluginBindingType,
  app: string,
  pluginId: string,
  name: string,
  env: EnvName
): string {
  const parts = [app, pluginId, name]
  if (type === 'kv') {
    const upper = parts.map(p => p.replace(/-/g, '_').toUpperCase()).join('_')
    return env === 'staging' ? `${upper}_STAGING` : upper
  }
  const lower = parts.join('-')
  return env === 'staging' ? `${lower}-staging` : lower
}

/**
 * The `<PLACEHOLDER>` an unprovisioned KV block carries, in the kit's own spelling
 * (`<KV_RATE_LIMIT_ID>` / `<KV_RATE_LIMIT_STAGING_ID>`), so `tomlPlaceholders` and the
 * `REQUIRE_PROVISIONED=1` parity check see it exactly as they see the kit's.
 */
export function pluginKvPlaceholder(pluginId: string, name: string, env: EnvName): string {
  const base = `KV_${[pluginId, name].map(p => p.replace(/-/g, '_').toUpperCase()).join('_')}`
  return env === 'staging' ? `<${base}_STAGING_ID>` : `<${base}_ID>`
}

function fail(pluginId: string, message: string): never {
  throw new PluginResourceError(`plugin "${pluginId}": ${message}`)
}

/** Validate one `bindings[]` entry. An unsupported `type` is named in the message, never skipped. */
export function validatePluginBinding(pluginId: string, raw: unknown): PluginBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail(pluginId, `bindings[] entry is not an object: ${JSON.stringify(raw)}`)
  const b = raw as Record<string, unknown>
  const type = b.type
  if (typeof type !== 'string') fail(pluginId, 'bindings[] entry has no `type`')
  if (!(SUPPORTED_PLUGIN_BINDING_TYPES as readonly string[]).includes(type))
    fail(
      pluginId,
      `binding type "${type}" is not provisioned by this kit (supported: ${SUPPORTED_PLUGIN_BINDING_TYPES.join(', ')}). ` +
        `Create the resource and add the block to BOTH tomls by hand, or open the type up in scripts/provision/plugin-resources.ts.`
    )
  const binding = b.binding
  if (typeof binding !== 'string' || !BINDING_NAME.test(binding))
    fail(pluginId, `binding name ${JSON.stringify(binding)} must match ${BINDING_NAME}`)
  const narrowed = type as PluginBindingType
  // A `durable_object` has no account-scoped resource: its block is `name = "<BINDING>"` plus a
  // class, identical in both files. Demanding a `name` there would invent a value nothing reads.
  const name = isNamed(narrowed) ? b.name : (b.name ?? '')
  if (typeof name !== 'string' || (isNamed(narrowed) && !RESOURCE_NAME.test(name)))
    fail(pluginId, `binding "${binding}": name ${JSON.stringify(name)} must match ${RESOURCE_NAME}`)
  if (!isNamed(narrowed) && name !== '')
    fail(pluginId, `binding "${binding}": a ${type} has no account-scoped name; drop \`name\``)
  if (b.consumer !== undefined && typeof b.consumer !== 'boolean')
    fail(pluginId, `binding "${binding}": consumer must be a boolean`)
  if (b.consumer === true && type !== 'queue')
    fail(pluginId, `binding "${binding}": consumer is only meaningful on a queue`)

  const className = b.className
  if (isClassBinding(narrowed)) {
    if (typeof className !== 'string' || !CLASS_NAME.test(className)) {
      fail(
        pluginId,
        `binding "${binding}": a ${type} must declare className (the class its worker-exports.ts re-exports)`
      )
    }
  } else if (className !== undefined) {
    fail(pluginId, `binding "${binding}": className is only meaningful on a class binding`)
  }

  const storage = b.storage
  if (narrowed === 'durable_object') {
    if (typeof storage !== 'string' || !(DO_STORAGE_KINDS as readonly string[]).includes(storage)) {
      fail(
        pluginId,
        `binding "${binding}": storage must be ${DO_STORAGE_KINDS.join(' | ')} — it picks ` +
          'new_sqlite_classes vs new_classes and a namespace cannot be migrated between them'
      )
    }
  } else if (storage !== undefined) {
    fail(pluginId, `binding "${binding}": storage is only meaningful on a durable_object`)
  }

  return {
    type: narrowed,
    binding,
    name,
    ...(b.consumer === true ? { consumer: true as const } : {}),
    ...(typeof className === 'string' ? { className } : {}),
    ...(typeof storage === 'string' ? { storage: storage as DoStorageKind } : {}),
  }
}

function validateVar(pluginId: string, raw: unknown): PluginVar {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail(pluginId, `vars[] entry is not an object: ${JSON.stringify(raw)}`)
  const v = raw as Record<string, unknown>
  if (typeof v.key !== 'string' || !VAR_KEY.test(v.key))
    fail(pluginId, `vars[] key ${JSON.stringify(v.key)} must match ${VAR_KEY}`)
  if (v.example !== undefined && typeof v.example !== 'string')
    fail(pluginId, `vars[] "${v.key}": example must be a string`)
  if (v.secret !== undefined && typeof v.secret !== 'boolean')
    fail(pluginId, `vars[] "${v.key}": secret must be a boolean`)
  return {
    key: v.key,
    example: typeof v.example === 'string' ? v.example : '',
    secret: v.secret === true,
  }
}

function strings(pluginId: string, field: string, raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string'))
    fail(pluginId, `${field} must be an array of strings`)
  return raw as string[]
}

/**
 * Validate the four platform declarations of one parsed `plugin.json`. Duplicate binding names
 * within a plugin are refused here; ACROSS plugins they are refused by `pluginResourceList`,
 * because that is the first place two plugins are seen together.
 */
export function validatePluginManifest(raw: unknown, anchor: string): PluginResources {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new PluginResourceError(`${anchor} is not an object`)
  const m = raw as Record<string, unknown>
  const id = typeof m.id === 'string' ? m.id : ''
  if (!id) throw new PluginResourceError(`${anchor} has no \`id\``)
  const rawBindings = m.bindings === undefined ? [] : m.bindings
  if (!Array.isArray(rawBindings)) fail(id, 'bindings must be an array')
  const bindings = (rawBindings as unknown[]).map(b => validatePluginBinding(id, b))
  const seen = new Set<string>()
  for (const b of bindings) {
    if (seen.has(b.binding)) fail(id, `declares binding "${b.binding}" twice`)
    seen.add(b.binding)
  }
  const rawVars = m.vars === undefined ? [] : m.vars
  if (!Array.isArray(rawVars)) fail(id, 'vars must be an array')
  return {
    id,
    anchor,
    bindings,
    crons: strings(id, 'crons', m.crons),
    apiPrefixes: strings(id, 'apiPrefixes', m.apiPrefixes),
    vars: (rawVars as unknown[]).map(v => validateVar(id, v)),
  }
}

/** A manifest surface, narrowed to what this module needs (see scripts/lib/upgrade-lib.d.mts). */
export interface SurfaceLike {
  id: string
  kind: string
  anchor: string
}

/**
 * Read every installed plugin's declarations. `surfaces` is the MERGED list — the committed
 * manifest plus the git-ignored sidecar — and presence is still `existsSync` on the anchor, so a
 * plugin whose directory was deleted contributes nothing and needs no bookkeeping (§16).
 */
export function readPluginResources(rootDir: string, surfaces: SurfaceLike[]): PluginResources[] {
  const out: PluginResources[] = []
  for (const surface of surfaces) {
    if (surface.kind !== 'plugin') continue
    const anchor = path.join(rootDir, surface.anchor)
    if (!fs.existsSync(anchor)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(anchor, 'utf8'))
    } catch (error) {
      throw new PluginResourceError(
        `${surface.anchor} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    out.push(validatePluginManifest(parsed, surface.anchor))
  }
  return out
}

/**
 * Every resource one environment needs, for `cf-provision.sh` to find-or-create. Two plugins
 * claiming one `binding` name is refused here: the second would silently shadow the first in
 * `Cloudflare.Env` and the failure would surface as a wrong bucket, not as an error.
 */
export function pluginResourceList(
  app: string,
  plugins: PluginResources[],
  env: EnvName
): ResourceRecord[] {
  const byBinding = new Map<string, string>()
  const out: ResourceRecord[] = []
  for (const plugin of plugins) {
    for (const b of plugin.bindings) {
      const owner = byBinding.get(b.binding)
      if (owner)
        throw new PluginResourceError(
          `binding "${b.binding}" is declared by both "${owner}" and "${plugin.id}" — one of them must rename it`
        )
      byBinding.set(b.binding, plugin.id)
      // Only the types an account has to CREATE reach `cf-provision.sh`. A workflow or a Durable
      // Object is registered by `wrangler deploy` from the block provisioning already wrote, so
      // passing one down would be an unsupported type in a script that is right to refuse it.
      if (!isCreated(b.type)) continue
      out.push({
        type: b.type,
        name: pluginResourceName(b.type, app, plugin.id, b.name, env),
        binding: b.binding,
      })
    }
  }
  return out
}

/** Flattened, deduplicated declarations across every installed plugin. */
export function pluginDeclarations(plugins: PluginResources[]): {
  crons: string[]
  apiPrefixes: string[]
  vars: PluginVar[]
} {
  const crons = [...new Set(plugins.flatMap(p => p.crons))]
  const apiPrefixes = [...new Set(plugins.flatMap(p => p.apiPrefixes))]
  const vars: PluginVar[] = []
  const seen = new Set<string>()
  for (const v of plugins.flatMap(p => p.vars)) {
    if (seen.has(v.key)) continue
    seen.add(v.key)
    vars.push(v)
  }
  return { crons, apiPrefixes, vars }
}

/**
 * Every toml block one environment needs for the installed plugins — the ONE mapping from a
 * declaration to a `[[…]]` block, so `pnpm provision cloudflare <env>` and the parity test's
 * fixture cannot disagree about what provisioning writes.
 *
 * A KV id is a `<PLACEHOLDER>` here: the block has to exist before `cf-provision.sh` can patch the
 * real id INTO it, and `REQUIRE_PROVISIONED=1` is what refuses the placeholder at deploy time.
 */
export function pluginBindingBlocks(
  app: string,
  plugins: PluginResources[],
  env: EnvName
): BindingBlock[] {
  return plugins.flatMap(plugin =>
    plugin.bindings.map(b => ({
      type: b.type,
      binding: b.binding,
      pluginId: plugin.id,
      ...(b.type === 'kv'
        ? { id: pluginKvPlaceholder(plugin.id, b.name, env) }
        : isNamed(b.type)
          ? { name: pluginResourceName(b.type, app, plugin.id, b.name, env) }
          : {}),
      ...(b.consumer ? { consumer: true } : {}),
      ...(b.className ? { className: b.className } : {}),
    }))
  )
}

/**
 * One `[[migrations]]` entry per plugin that ships Durable Object classes, tagged `plugin-<id>-v1`.
 *
 * **Always `v1`, because this is the INSTALL entry** and a tag is an identity Cloudflare has
 * already acted on. Anything later — a removal's `deleted_classes` — takes the next free number
 * through `nextPluginMigrationTag`; nothing ever renumbers or rewrites one.
 */
export function pluginMigrationBlocks(plugins: PluginResources[]): MigrationBlock[] {
  const out: MigrationBlock[] = []
  for (const plugin of plugins) {
    const classes = plugin.bindings.filter(b => b.type === 'durable_object')
    if (classes.length === 0) continue
    const named = (kind: DoStorageKind) =>
      classes.filter(b => b.storage === kind).map(b => b.className as string)
    const newSqliteClasses = named('sqlite')
    const newClasses = named('none')
    out.push({
      tag: pluginMigrationTag(plugin.id),
      pluginId: plugin.id,
      ...(newClasses.length ? { newClasses } : {}),
      ...(newSqliteClasses.length ? { newSqliteClasses } : {}),
    })
  }
  return out
}

// ---- parity ---------------------------------------------------------------------------------

/** A parsed wrangler toml, read loosely — this module never re-serialises one. */
type TomlDoc = Record<string, unknown>

function rows(doc: unknown, dotted: string): Array<Record<string, unknown>> {
  const v = dotted
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as TomlDoc)[key] : undefined),
      doc
    )
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []
}

function list(doc: unknown, dotted: string): string[] {
  const v = dotted
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as TomlDoc)[key] : undefined),
      doc
    )
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Where each type's block lives, how it is IDENTIFIED there, and which key holds the value that
 * differs per environment.
 *
 * `idKey` is `name` for a Durable Object because that is how the toml spells a DO binding — the
 * kit's own is `name = "NOTIFICATIONS_HUB"` — and `nameKey` is null there because nothing in the
 * block differs between the two files at all.
 */
const SECTION_OF: Record<
  PluginBindingType,
  { section: string; idKey: string; nameKey: string | null }
> = {
  kv: { section: 'kv_namespaces', idKey: 'binding', nameKey: 'id' },
  queue: { section: 'queues.producers', idKey: 'binding', nameKey: 'queue' },
  r2: { section: 'r2_buckets', idKey: 'binding', nameKey: 'bucket_name' },
  workflow: { section: 'workflows', idKey: 'binding', nameKey: 'name' },
  durable_object: { section: 'durable_objects.bindings', idKey: 'name', nameKey: null },
}

const IS_PLACEHOLDER = /^<[A-Z0-9_]+>$/

/**
 * Everything a plugin declared that the two tomls do not (yet) agree about — the D6 parity rules
 * applied to plugin resources, as one pure function so `wrangler-parity.test.ts` can run it against
 * FIXTURES as well as against what is installed. With no plugins installed (a bare kit) it returns
 * `[]` for any pair of documents, so the rule is only meaningful when exercised against a fixture,
 * which is precisely why it is a function and not an inline block of assertions.
 *
 * `requireProvisioned` is the `REQUIRE_PROVISIONED=1` half, and it now covers three things rather
 * than one: a KV id may be a `<PLACEHOLDER>`, and the crons and `run_worker_first` prefixes a
 * plugin declares may be absent, while the environment is unprovisioned. None of them may be at
 * deploy time.
 *
 * Crons and prefixes are gated because `pnpm plugin add` deliberately does not touch a toml (D31,
 * decision 12) — `pnpm provision cloudflare <env>` writes them. So a checkout that has installed a
 * plugin and not yet provisioned is a legitimate, documented state, and the ordinary gate must not
 * fail it. The kit's own CI is exactly that state: it installs every `defaultPlugins` entry and has
 * no Cloudflare credentials to provision with. `deploy.yml` runs this same test with
 * `REQUIRE_PROVISIONED=1`, so an app that installed a plugin and never provisioned is still stopped
 * before it can deploy, which is the moment the missing cron or prefix would actually bite.
 */
export function pluginParityIssues(
  app: string,
  plugins: PluginResources[],
  docs: { production: unknown; staging: unknown },
  opts: { requireProvisioned?: boolean } = {}
): string[] {
  const issues: string[] = []
  const envs: Array<[EnvName, unknown]> = [
    ['production', docs.production],
    ['staging', docs.staging],
  ]
  for (const plugin of plugins) {
    for (const b of plugin.bindings) {
      const { section, idKey, nameKey } = SECTION_OF[b.type]
      for (const [env, doc] of envs) {
        const row = rows(doc, section).find(r => r[idKey] === b.binding)
        if (!row) {
          issues.push(`${env}: [[${section}]] has no binding "${b.binding}" (plugin ${plugin.id})`)
          continue
        }
        // A class binding is only as good as the class it names, and the name has to be identical
        // in both files — `class_name` is resolved against the Worker's exports, which are the
        // same code in both environments.
        if (b.className && row.class_name !== b.className) {
          issues.push(
            `${env}: "${b.binding}" class_name is ${JSON.stringify(row.class_name)}, want "${b.className}"`
          )
        }
        // A Durable Object block has nothing that differs per environment, so there is nothing
        // left to compare once the binding and the class agree.
        if (nameKey === null) continue
        const value = row[nameKey]
        if (b.type === 'kv') {
          if (typeof value !== 'string' || value === '')
            issues.push(`${env}: "${b.binding}" has no id`)
          else if (opts.requireProvisioned && IS_PLACEHOLDER.test(value))
            issues.push(`${env}: "${b.binding}" id is still ${value}`)
          continue
        }
        const expected = pluginResourceName(b.type, app, plugin.id, b.name, env)
        if (value !== expected)
          issues.push(
            `${env}: "${b.binding}" ${nameKey} is ${JSON.stringify(value)}, want "${expected}"`
          )
        if (b.type === 'queue' && b.consumer) {
          if (!rows(doc, 'queues.consumers').some(r => r[nameKey] === expected))
            issues.push(`${env}: no [[queues.consumers]] for "${expected}" (plugin ${plugin.id})`)
        }
      }
    }
    // A Durable Object binding with no `[[migrations]]` entry creating its class is a toml
    // `wrangler deploy` REFUSES — the whole script, not just that binding — so this is checked
    // beside the block rather than gated behind `requireProvisioned`: both are written by the same
    // `provision cloudflare` call, so their presence is perfectly correlated.
    const doBindings = plugin.bindings.filter(b => b.type === 'durable_object')
    if (doBindings.length > 0) {
      const tag = pluginMigrationTag(plugin.id)
      for (const [env, doc] of envs) {
        const entry = rows(doc, 'migrations').find(r => r.tag === tag)
        if (!entry) {
          issues.push(`${env}: [[migrations]] has no tag "${tag}" (plugin ${plugin.id})`)
          continue
        }
        const created = new Set(
          [
            ...(Array.isArray(entry.new_classes) ? entry.new_classes : []),
            ...(Array.isArray(entry.new_sqlite_classes) ? entry.new_sqlite_classes : []),
          ].map(String)
        )
        for (const b of doBindings) {
          if (b.className && !created.has(b.className))
            issues.push(`${env}: [[migrations]] "${tag}" does not create ${b.className}`)
        }
      }
    }
    // Written by `provision cloudflare`, not by `plugin add` — so only required once provisioned.
    if (opts.requireProvisioned) {
      for (const cron of plugin.crons)
        for (const [env, doc] of envs)
          if (!list(doc, 'triggers.crons').includes(cron))
            issues.push(`${env}: [triggers] crons is missing "${cron}" (plugin ${plugin.id})`)
      for (const prefix of plugin.apiPrefixes)
        for (const [env, doc] of envs)
          for (const pattern of [prefix, `${prefix}/*`])
            if (!list(doc, 'assets.run_worker_first').includes(pattern))
              issues.push(
                `${env}: [assets] run_worker_first is missing "${pattern}" (plugin ${plugin.id})`
              )
    }
    for (const v of plugin.vars) {
      if (v.secret) continue
      for (const [env, doc] of envs) {
        const vars = (doc as TomlDoc)?.vars
        if (!vars || typeof vars !== 'object' || !(v.key in (vars as TomlDoc)))
          issues.push(`${env}: [vars] is missing "${v.key}" (plugin ${plugin.id})`)
      }
    }
  }
  return issues
}
