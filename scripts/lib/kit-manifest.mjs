/**
 * `launch.kit.json`, checked in plain JS: the same shape Launch parses with zod
 * (`@launch/shared/kit-manifest` in Launch). Required fields, types, patterns and literals match;
 * unknown fields are allowed (readers tolerate them); defaults are applied so callers see the
 * same values Launch would. When Launch's schema changes, change this file in the same release.
 * The meta-kit (rocketflare-dev/launch-kit) ships the same file: change both together.
 *
 * `validateManifest(value)` → `{ manifest, problems }`, `problems` one line each (`path: why`).
 */

export const KIT_MANIFEST_PATH = 'launch.kit.json'
export const KIT_MANIFEST_SCHEMA_VERSION = 1

/** The Cloudflare binding kinds Launch can provision (Launch's `deploy/binding-check.ts`). */
export const PROVISIONABLE_BINDING_KINDS = [
  'kv_namespaces',
  'queues',
  'r2_buckets',
  'durable_objects',
  'workflows',
  'ai',
  'assets',
]

const KIT_ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const WORKFLOW_FILE = /^[\w.-]+\.ya?ml$/
const EXTENSION = /^[a-z_][a-z0-9_]*$/
const TITLE_SUFFIX = /^[a-z0-9][a-z0-9-]*$/

export function validateManifest(input) {
  const problems = []
  const bad = (path, why) => problems.push(`${path}: ${why}`)
  const at = (path, key) => (path ? `${path}.${key}` : key)
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

  /** Read `obj[key]` at `path`; check it with `test`; apply a default when absent. */
  const field = (obj, key, path, test, { optional = false, def } = {}) => {
    if (!isObj(obj)) return undefined
    const v = obj[key]
    if (v === undefined) {
      if (def !== undefined) {
        obj[key] = typeof def === 'function' ? def() : structuredClone(def)
        return obj[key]
      }
      if (!optional) bad(at(path, key), 'required')
      return undefined
    }
    const why = test(v)
    if (why) bad(at(path, key), why)
    return v
  }
  const str =
    (min = 1, max = Number.POSITIVE_INFINITY, { trim = false } = {}) =>
    v => {
      if (typeof v !== 'string') return 'must be a string'
      const s = trim ? v.trim() : v
      if (s.length < min) return min === 1 ? 'must not be empty' : `at least ${min} characters`
      if (s.length > max) return `at most ${max} characters`
      return null
    }
  const pattern = (re, why) => v => (typeof v === 'string' && re.test(v) ? null : why)
  const command = str(1, 500, { trim: true })
  const relPath = v => {
    const why = str(1, 300, { trim: true })(v)
    if (why) return why
    if (v.trim().startsWith('/') || v.split('/').includes('..'))
      return 'must be a path inside the repo'
    return null
  }
  const envName = pattern(ENV_NAME, 'must be an UPPER_SNAKE env name')
  const literal = expected => v => (v === expected ? null : `must be ${JSON.stringify(expected)}`)
  const object = v => (isObj(v) ? null : 'must be an object')
  const arrayOf = test => v => {
    if (!Array.isArray(v)) return 'must be an array'
    for (const [k, item] of v.entries()) {
      const why = test(item)
      if (why) return `[${k}] ${why}`
    }
    return null
  }
  const block = (obj, key, path, { optional = false, def } = {}) => {
    const v = field(obj, key, path, object, { optional, def })
    return isObj(v) ? v : undefined
  }

  if (!isObj(input)) return { manifest: null, problems: ['manifest: must be a JSON object'] }
  const m = structuredClone(input)
  field(m, 'schema', '', literal(KIT_MANIFEST_SCHEMA_VERSION))

  const kit = block(m, 'kit', '')
  if (kit) {
    field(kit, 'id', 'kit', pattern(KIT_ID, 'lowercase letters, digits and dashes (3-40)'))
    field(kit, 'name', 'kit', str(1, 80, { trim: true }))
    field(kit, 'description', 'kit', str(0, 300, { trim: true }), { optional: true })
    field(kit, 'icon', 'kit', str(0, 300, { trim: true }), { optional: true })
    field(kit, 'repo', 'kit', str(1, 300, { trim: true }), { optional: true })
    const version = block(kit, 'version', 'kit', {
      def: { file: 'package.json', field: 'version' },
    })
    if (version) {
      field(version, 'file', 'kit.version', relPath)
      field(version, 'field', 'kit.version', str(1, 100))
    }
    field(
      kit,
      'tagPattern',
      'kit',
      v => {
        const why = str(1, 200)(v)
        if (why) return why
        try {
          new RegExp(v)
          return null
        } catch {
          return 'must be a regular expression'
        }
      },
      { def: '^\\d+\\.\\d+\\.\\d+$' }
    )
  }

  const scaffold = block(m, 'scaffold', '')
  if (scaffold) {
    field(scaffold, 'init', 'scaffold', command)
    field(scaffold, 'kitOnly', 'scaffold', arrayOf(str(1, 300)), { def: [] })
    field(scaffold, 'postInit', 'scaffold', arrayOf(command), { def: [] })
    field(scaffold, 'appManifest', 'scaffold', relPath)
  }

  const worker = block(m, 'worker', '')
  if (worker) {
    const tomls = block(worker, 'tomls', 'worker')
    if (tomls) {
      field(tomls, 'production', 'worker.tomls', relPath)
      field(tomls, 'staging', 'worker.tomls', relPath)
    }
    const naming = block(worker, 'naming', 'worker', { def: {} })
    if (naming) {
      field(naming, 'pattern', 'worker.naming', literal('{slug}-{suffix}'), {
        def: '{slug}-{suffix}',
      })
      field(naming, 'stagingSuffix', 'worker.naming', str(1, 30), { def: '-staging' })
    }
    field(
      worker,
      'titles',
      'worker',
      v => {
        if (!isObj(v)) return 'must be an object'
        for (const [k, val] of Object.entries(v)) {
          if (k.length < 1 || k.length > 100) return `key ${k} must be 1-100 characters`
          if (typeof val !== 'string' || !TITLE_SUFFIX.test(val))
            return `${k} must be lowercase letters, digits and dashes`
        }
        return null
      },
      { optional: true }
    )
  }

  const provides = block(m, 'launchProvides', '')
  if (provides) {
    field(provides, 'appUrl', 'launchProvides', envName)
    field(provides, 'emailFrom', 'launchProvides', envName, { optional: true })
    field(provides, 'databaseUrl', 'launchProvides', envName)
    const driver = block(provides, 'databaseDriver', 'launchProvides', { optional: true })
    if (driver) {
      field(driver, 'name', 'launchProvides.databaseDriver', envName)
      field(driver, 'value', 'launchProvides.databaseDriver', str(1))
    }
    const oidc = block(provides, 'oidc', 'launchProvides')
    if (oidc) {
      for (const key of ['issuer', 'clientId', 'clientSecret'])
        field(oidc, key, 'launchProvides.oidc', envName)
      for (const key of ['only', 'label'])
        field(oidc, key, 'launchProvides.oidc', envName, { optional: true })
    }
    field(provides, 'bootstrapAdmins', 'launchProvides', envName, { optional: true })
    field(provides, 'emailApiKey', 'launchProvides', envName, { optional: true })
    field(
      provides,
      'generated',
      'launchProvides',
      arrayOf(v =>
        !isObj(v)
          ? 'must be an object'
          : envName(v.name)
            ? `name ${envName(v.name)}`
            : v.kind !== 'hex64'
              ? 'kind must be "hex64"'
              : null
      ),
      { def: [] }
    )
    field(
      provides,
      'vars',
      'launchProvides',
      v => {
        if (!isObj(v)) return 'must be an object'
        for (const [k, val] of Object.entries(v)) {
          if (!ENV_NAME.test(k)) return `key ${k} must be an UPPER_SNAKE env name`
          if (typeof val !== 'string') return `${k} must be a string`
        }
        return null
      },
      { def: {} }
    )
  }

  const declared = block(m, 'declaredConfig', '', { def: {} })
  if (declared) {
    field(declared, 'optional', 'declaredConfig', arrayOf(envName), { def: [] })
    field(declared, 'pluginManifests', 'declaredConfig', str(1, 300), { optional: true })
  }

  const database = block(m, 'database', '')
  if (database) {
    const roles = block(database, 'roles', 'database', {
      def: { migrator: 'migrator', app: 'app' },
    })
    if (roles) {
      field(roles, 'migrator', 'database.roles', str(1, 63))
      field(roles, 'app', 'database.roles', str(1, 63))
    }
    field(
      database,
      'extensions',
      'database',
      arrayOf(pattern(EXTENSION, 'must be an extension name')),
      { def: [] }
    )
    field(database, 'migrate', 'database', command)
    field(database, 'rlsRole', 'database', str(1, 63), { optional: true })
  }

  const health = block(m, 'health', '', { def: {} })
  if (health) {
    const path = v => (typeof v === 'string' && v.startsWith('/') ? null : "must start with '/'")
    field(health, 'live', 'health', path, { def: '/api/health' })
    field(health, 'ready', 'health', path, { def: '/api/ready' })
  }

  const ci = block(m, 'ci', '')
  if (ci) {
    field(ci, 'requiredCheck', 'ci', str(1, 100))
    field(ci, 'gateList', 'ci', command)
    field(ci, 'gateRun', 'ci', command)
    field(ci, 'verifiedVariable', 'ci', envName, { optional: true })
    const testEnv = block(ci, 'testEnv', 'ci', { optional: true })
    if (testEnv) {
      field(testEnv, 'branch', 'ci.testEnv', envName)
      field(testEnv, 'endpoint', 'ci.testEnv', envName, { optional: true })
    }
  }

  const release = block(m, 'release', '')
  if (release) {
    field(
      release,
      'workflow',
      'release',
      pattern(WORKFLOW_FILE, 'must be a workflow file name (x.yml)')
    )
    field(release, 'environmentInput', 'release', str(1, 50), { def: 'environment' })
    field(release, 'deployerProtocol', 'release', literal(1))
  }

  const session = block(m, 'session', '')
  if (session) {
    field(session, 'install', 'session', command)
    field(session, 'bootstrap', 'session', command)
    field(session, 'devStart', 'session', command)
    field(session, 'devStop', 'session', command, { optional: true })
    const ports = block(session, 'ports', 'session')
    if (ports) {
      field(ports, 'ui', 'session.ports', envName)
      field(ports, 'api', 'session.ports', envName)
      field(ports, 'allowedHosts', 'session.ports', envName, { optional: true })
    }
    field(session, 'writes', 'session', arrayOf(relPath), { def: [] })
    const env = block(session, 'env', 'session', { def: {} })
    if (env) {
      field(env, 'skip', 'session.env', envName, { optional: true })
      field(env, 'allowRoot', 'session.env', envName, { optional: true })
    }
  }

  const upgrade = block(m, 'upgrade', '', { optional: true })
  if (upgrade) {
    field(upgrade, 'command', 'upgrade', command)
    field(upgrade, 'skill', 'upgrade', relPath, { optional: true })
    field(upgrade, 'notes', 'upgrade', str(1, 300), { optional: true })
    field(upgrade, 'doneMarker', 'upgrade', str(1, 60), { def: 'LAUNCH-UPGRADE:' })
  }

  const plugins = block(m, 'plugins', '', { optional: true })
  if (plugins) {
    field(
      plugins,
      'defaults',
      'plugins',
      arrayOf(v => {
        if (!isObj(v)) return 'must be an object'
        for (const [k, max] of [
          ['id', 60],
          ['repo', 300],
          ['ref', 100],
        ]) {
          const why = str(1, max)(v[k])
          if (why) return `${k} ${why}`
        }
        if (v.subdir !== undefined && str(0, 300)(v.subdir)) return 'subdir must be a string'
        return null
      }),
      { def: [] }
    )
    field(plugins, 'add', 'plugins', command, { optional: true })
  }

  field(
    m,
    'modules',
    '',
    arrayOf(v => {
      if (!isObj(v)) return 'must be an object'
      if (str(1, 60)(v.id)) return 'id must be 1-60 characters'
      if (str(1, 80)(v.name)) return 'name must be 1-80 characters'
      if (v.description !== undefined && str(0, 300)(v.description)) return 'description too long'
      return null
    }),
    { optional: true }
  )

  return { manifest: problems.length ? null : m, problems }
}

/** Substitute `{name}` placeholders; an unknown one throws (as Launch's `fillTemplate`). */
export function fillTemplate(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (_, name) => {
    if (values[name] === undefined)
      throw new Error(`Unknown placeholder {${name}} in "${template}"`)
    return values[name]
  })
}
