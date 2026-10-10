#!/usr/bin/env node
/**
 * The Launch kit conformance check, static half — what Launch checks before a kit can be picked,
 * run here so a fork knows it still conforms before it ever registers.
 *
 *   node scripts/kit-check.mjs [dir] [--json] [--provisioned] [--exec]
 *
 * Checks, each a line in the report:
 *
 *   manifest      launch.kit.json parses and has Launch's shape (scripts/lib/kit-manifest.mjs)
 *   files         every must-have file exists: the init, gate, bootstrap, dev and migrate entry
 *                 points the manifest's commands name, both workflows, both tomls, CLAUDE.md or
 *                 AGENTS.md, the upgrade skill when declared; a copy's app manifest has its shape
 *   ci            ci.yml has a job whose check name is ci.requiredCheck and reads the
 *                 gate-verified variable
 *   release       the deploy workflow: a tag push and a published release trigger it,
 *                 workflow_dispatch takes the environment input, its jobs hold `id-token: write`,
 *                 run the deployer's start → upload → activate → finish (finish `if: always()`) and
 *                 deploy to the `staging` and `production` environments
 *   tomls         both parse; only provisionable binding kinds; every id a <PLACEHOLDER> (with
 *                 --provisioned: none is); every account-scoped name follows {slug}-{suffix} with
 *                 the staging suffix in staging; the two have the same shape
 *   provides      (warnings) every var name in launchProvides is read somewhere in the Worker
 *   gate-list     (--exec only) `ci.gateList` prints gate list schema 1 with lint/typecheck/test
 *
 * The slug the names are checked against is the copy's (`app.slug` in the app manifest) or, in
 * the kit itself, `scaffold.tokens.slug` (else `kit.id`). Exit 0 conformant, 1 not, 2 usage. Node built-ins only.
 *
 * SHARED with the meta-kit (rocketflare-dev/launch-kit `scripts/kit-check.mjs`, with
 * `scripts/lib/{kit-manifest,toml-lite,yaml-lite}.mjs`): one checker, the same rules Launch
 * applies. Both copies must change together — a fix in one is a fix in the other, same release.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KIT_MANIFEST_PATH,
  PROVISIONABLE_BINDING_KINDS,
  validateManifest,
} from './lib/kit-manifest.mjs'
import { parseToml } from './lib/toml-lite.mjs'
import { parseYaml } from './lib/yaml-lite.mjs'

/** Top-level toml keys that bind nothing (Launch's binding check, INERT_KEYS). */
const INERT_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'account_id',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'placement',
  'observability',
  'limits',
  'triggers',
  'logpush',
  'keep_vars',
  'minify',
  'no_bundle',
  'rules',
  'build',
  'base_dir',
  'find_additional_modules',
  'preserve_file_names',
  'upload_source_maps',
  'send_metrics',
  'dev',
  'alias',
  'define',
  'tsconfig',
  'usage_model',
  'vars',
  'migrations',
])
const PLACEHOLDER = /^<[A-Z0-9_]+>$/
const GATE_STEPS_LAUNCH_RUNS = ['lint', 'typecheck', 'test']

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const asArray = v => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

/**
 * The file a command runs, when it names one: `node <file>`, `tsx <file>`, or `pnpm <script>` /
 * `pnpm run <script>` (a root package.json script). `null` for anything else (a pnpm built-in).
 */
export function commandTarget(command) {
  const words = command.trim().split(/\s+/)
  if (['node', 'tsx'].includes(words[0])) {
    const file = words.slice(1).find(w => !w.startsWith('-'))
    return file ? { kind: 'file', file } : null
  }
  if (words[0] === 'pnpm') {
    const rest = words.slice(1).filter(w => !w.startsWith('-'))
    const script = rest[0] === 'run' ? rest[1] : rest[0]
    if (!script || ['install', 'i', 'exec', 'dlx', 'add', '--filter'].includes(script)) return null
    return { kind: 'script', script }
  }
  return null
}

/** Every account-scoped name a toml declares, with where. */
export function scopedNames(toml) {
  const out = []
  if (typeof toml.name === 'string') out.push({ where: 'name', name: toml.name, worker: true })
  for (const [k, p] of asArray(toml.queues?.producers).entries())
    out.push({ where: `queues.producers[${k}].queue`, name: p?.queue })
  for (const [k, c] of asArray(toml.queues?.consumers).entries()) {
    out.push({ where: `queues.consumers[${k}].queue`, name: c?.queue })
    if (c?.dead_letter_queue)
      out.push({ where: `queues.consumers[${k}].dead_letter_queue`, name: c.dead_letter_queue })
  }
  for (const [k, b] of asArray(toml.r2_buckets).entries())
    out.push({ where: `r2_buckets[${k}].bucket_name`, name: b?.bucket_name })
  for (const [k, w] of asArray(toml.workflows).entries())
    out.push({ where: `workflows[${k}].name`, name: w?.name })
  return out
}

/** Problems with one toml: kinds, ids, names. Pure. */
export function tomlProblems(toml, { slug, env, stagingSuffix, provisioned = false, label }) {
  const problems = []
  const bad = msg => problems.push(`${label}: ${msg}`)
  for (const key of Object.keys(toml)) {
    if (PROVISIONABLE_BINDING_KINDS.includes(key) || INERT_KEYS.has(key)) continue
    if (key === 'route' || key === 'routes')
      bad(`${key}: Launch owns the app's hostnames; remove it`)
    else
      bad(
        `${key}: not a binding kind Launch provisions (${PROVISIONABLE_BINDING_KINDS.join(', ')})`
      )
  }
  if (typeof toml.main !== 'string') bad('main: required')
  for (const [k, kv] of asArray(toml.kv_namespaces).entries()) {
    for (const idKey of ['id', 'preview_id']) {
      const id = kv?.[idKey]
      if (id === undefined) {
        if (idKey === 'id') bad(`kv_namespaces[${k}].id: required`)
        continue
      }
      if (provisioned && PLACEHOLDER.test(String(id)))
        bad(`kv_namespaces[${k}].${idKey}: still the placeholder ${id}`)
      if (!provisioned && !PLACEHOLDER.test(String(id)))
        bad(`kv_namespaces[${k}].${idKey}: must be a <PLACEHOLDER> in the kit, got ${id}`)
    }
  }
  const worker = env === 'staging' ? `${slug}${stagingSuffix}` : slug
  for (const { where, name, worker: isWorker } of scopedNames(toml)) {
    if (typeof name !== 'string' || !name) {
      bad(`${where}: required`)
      continue
    }
    if (isWorker) {
      if (name !== worker) bad(`${where}: must be "${worker}", got "${name}"`)
      continue
    }
    const ok =
      name.startsWith(`${slug}-`) &&
      (env === 'staging'
        ? name.endsWith(stagingSuffix) && name.length > slug.length + 1 + stagingSuffix.length
        : !name.endsWith(stagingSuffix))
    if (!ok)
      bad(
        `${where}: "${name}" does not follow {slug}-{suffix}${env === 'staging' ? stagingSuffix : ''} for slug "${slug}"`
      )
  }
  for (const [k, d] of asArray(toml.durable_objects?.bindings).entries()) {
    if (d?.script_name && d.script_name !== worker)
      bad(`durable_objects.bindings[${k}].script_name: another Worker's class (${d.script_name})`)
  }
  for (const [k, w] of asArray(toml.workflows).entries()) {
    if (w?.script_name && w.script_name !== worker)
      bad(`workflows[${k}].script_name: another Worker's workflow (${w.script_name})`)
  }
  return problems
}

/** The toml with ids, var values and the environment's names normalised away: the "shape". */
export function tomlShape(toml, { slug, env, stagingSuffix }) {
  const shape = structuredClone(toml)
  const strip = name =>
    typeof name === 'string'
      ? name
          .replace(new RegExp(`^${escapeRe(slug)}`), '{slug}')
          .replace(env === 'staging' ? new RegExp(`${escapeRe(stagingSuffix)}$`) : /$^/, '')
      : name
  shape.name = strip(shape.name)
  for (const p of asArray(shape.queues?.producers)) p.queue = strip(p.queue)
  for (const c of asArray(shape.queues?.consumers)) {
    c.queue = strip(c.queue)
    if (c.dead_letter_queue) c.dead_letter_queue = strip(c.dead_letter_queue)
  }
  for (const b of asArray(shape.r2_buckets)) b.bucket_name = strip(b.bucket_name)
  for (const w of asArray(shape.workflows)) {
    w.name = strip(w.name)
    if (w.script_name) w.script_name = strip(w.script_name)
  }
  for (const kv of asArray(shape.kv_namespaces)) {
    if ('id' in kv) kv.id = '<id>'
    if ('preview_id' in kv) kv.preview_id = '<id>'
  }
  if (isObj(shape.vars)) shape.vars = Object.keys(shape.vars).sort()
  delete shape.workers_dev // Launch writes it into both
  return shape
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The paths at which two values differ (first few). */
export function diffPaths(a, b, at = '', out = []) {
  if (out.length >= 5) return out
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out)
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (const [k, v] of a.entries()) diffPaths(v, b[k], `${at}[${k}]`, out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at || '(root)')
  return out
}

/** Problems with ci.yml. Pure over the parsed workflow. */
export function ciProblems(workflow, text, { requiredCheck, verifiedVariable }) {
  const problems = []
  const jobs = isObj(workflow?.jobs) ? workflow.jobs : {}
  const names = Object.entries(jobs).map(([id, job]) =>
    typeof job?.name === 'string' ? job.name : id
  )
  if (!names.includes(requiredCheck)) {
    problems.push(
      `ci.yml: no job named "${requiredCheck}" (ci.requiredCheck); jobs: ${names.join(', ') || 'none'}`
    )
  }
  const on = workflow?.on
  const triggers = isObj(on) ? Object.keys(on) : asArray(on)
  if (!triggers.includes('pull_request'))
    problems.push('ci.yml: must run on pull_request (the required check)')
  if (verifiedVariable && !new RegExp(`vars\\.${verifiedVariable}\\b`).test(text)) {
    problems.push(`ci.yml: never reads vars.${verifiedVariable} (ci.verifiedVariable)`)
  }
  return problems
}

/** Problems with the deploy workflow (deployer protocol v1). Pure over the parsed workflow. */
export function releaseProblems(workflow, { file, environmentInput }) {
  const problems = []
  const bad = msg => problems.push(`${file}: ${msg}`)
  const on = isObj(workflow?.on) ? workflow.on : {}
  if (!asArray(on.push?.tags).length) bad('on.push.tags: a version tag (X.Y.Z) must deploy staging')
  if (!asArray(on.release?.types).includes('published'))
    bad('on.release.types: must include published (deploys production)')
  const input = on.workflow_dispatch?.inputs?.[environmentInput]
  if (!isObj(input))
    bad(`on.workflow_dispatch.inputs.${environmentInput}: required (release.environmentInput)`)
  else if (input.type === 'choice') {
    const options = asArray(input.options)
    for (const env of ['staging', 'production'])
      if (!options.includes(env))
        bad(`workflow_dispatch input ${environmentInput}: options must include ${env}`)
  }
  const jobs = isObj(workflow?.jobs) ? Object.values(workflow.jobs) : []
  const topIdToken = workflow?.permissions?.['id-token'] === 'write'
  const deployJobs = jobs.filter(job =>
    asArray(job?.steps).some(s => /deployer\.mjs\s+start/.test(String(s?.run ?? '')))
  )
  if (!deployJobs.length)
    bad('no job runs the deployer (node scripts/deployer.mjs start|upload|activate|finish)')
  const environments = new Set()
  for (const job of deployJobs) {
    const name = job.name ?? '(job)'
    const env = typeof job.environment === 'string' ? job.environment : job.environment?.name
    if (env) environments.add(env)
    if (!topIdToken && job.permissions?.['id-token'] !== 'write')
      bad(`${name}: needs permissions id-token: write`)
    const runs = asArray(job.steps).map(s => String(s?.run ?? ''))
    let last = -1
    for (const step of ['start', 'upload', 'activate', 'finish']) {
      const idx = runs.findIndex(r => new RegExp(`deployer\\.mjs\\s+${step}\\b`).test(r))
      if (idx < 0) bad(`${name}: never runs deployer.mjs ${step}`)
      else if (idx < last) bad(`${name}: deployer.mjs ${step} runs out of order`)
      else last = idx
    }
    const finish = asArray(job.steps).find(s =>
      /deployer\.mjs\s+finish\b/.test(String(s?.run ?? ''))
    )
    if (finish && !/always\(\)/.test(String(finish.if ?? '')))
      bad(`${name}: the finish step must run if: always()`)
    const jobEnv = JSON.stringify(job.env ?? {}) + JSON.stringify(workflow.env ?? {})
    if (!/DEPLOYER_URL/.test(jobEnv)) bad(`${name}: DEPLOYER_URL is not passed to the job`)
  }
  for (const env of ['staging', 'production']) {
    if (deployJobs.length && !environments.has(env))
      bad(`no deployer job runs in the ${env} environment (the OIDC environment claim)`)
  }
  return problems
}

/** Every file under `dir` (skipping node_modules, dist, .git), relative. */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.wrangler'].includes(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full))
  }
  return out
}

export function checkKit(dir, { provisioned = false, exec = false } = {}) {
  const checks = []
  const warnings = []
  const add = (id, problems) => checks.push({ id, ok: problems.length === 0, problems })
  const exists = rel => existsSync(path.join(dir, rel))
  const read = rel => readFileSync(path.join(dir, rel), 'utf8')

  // manifest
  let raw
  try {
    raw = JSON.parse(read(KIT_MANIFEST_PATH))
  } catch (err) {
    add('manifest', [
      exists(KIT_MANIFEST_PATH)
        ? `${KIT_MANIFEST_PATH}: ${err.message}`
        : `${KIT_MANIFEST_PATH}: missing`,
    ])
    return report(checks, warnings, null)
  }
  const { manifest, problems: manifestProblems } = validateManifest(raw)
  add(
    'manifest',
    manifestProblems.map(p => `${KIT_MANIFEST_PATH} ${p}`)
  )
  if (!manifest) return report(checks, warnings, null)

  // files
  const files = []
  let rootPackage = {}
  try {
    rootPackage = JSON.parse(read('package.json'))
  } catch {
    files.push('package.json: missing or not JSON')
  }
  const needCommand = (command, what) => {
    const target = commandTarget(command)
    if (!target) return
    if (target.kind === 'file' && !exists(target.file))
      files.push(`${what}: ${target.file} does not exist`)
    if (target.kind === 'script' && !rootPackage.scripts?.[target.script])
      files.push(`${what}: package.json has no "${target.script}" script`)
  }
  needCommand(manifest.scaffold.init, 'scaffold.init')
  for (const [k, c] of manifest.scaffold.postInit.entries())
    needCommand(c, `scaffold.postInit[${k}]`)
  needCommand(manifest.ci.gateList, 'ci.gateList')
  needCommand(manifest.ci.gateRun.replace('{step}', 'lint'), 'ci.gateRun')
  needCommand(manifest.database.migrate, 'database.migrate')
  needCommand(manifest.session.install, 'session.install')
  needCommand(manifest.session.bootstrap, 'session.bootstrap')
  needCommand(manifest.session.devStart, 'session.devStart')
  if (manifest.session.devStop) needCommand(manifest.session.devStop, 'session.devStop')
  if (manifest.upgrade) {
    needCommand(manifest.upgrade.command, 'upgrade.command')
    if (manifest.upgrade.skill && !exists(manifest.upgrade.skill))
      files.push(`upgrade.skill: ${manifest.upgrade.skill} does not exist`)
  }
  for (const rel of [
    '.github/workflows/ci.yml',
    `.github/workflows/${manifest.release.workflow}`,
    manifest.worker.tomls.production,
    manifest.worker.tomls.staging,
  ]) {
    if (!exists(rel)) files.push(`${rel}: missing`)
  }
  if (!exists('CLAUDE.md') && !exists('AGENTS.md'))
    files.push('CLAUDE.md or AGENTS.md: missing (how the kit governs what agents build)')
  const versionFile = manifest.kit.version.file
  try {
    const version = JSON.parse(read(versionFile))[manifest.kit.version.field]
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version))
      files.push(`${versionFile} ${manifest.kit.version.field}: not a version`)
  } catch {
    files.push(`kit.version: ${versionFile} is missing or not JSON`)
  }
  // The kit's own slug token (scaffold.tokens, a kit extension Launch ignores), else its id.
  let slug =
    typeof manifest.scaffold.tokens?.slug === 'string'
      ? manifest.scaffold.tokens.slug
      : manifest.kit.id
  let isCopy = false
  if (exists(manifest.scaffold.appManifest)) {
    try {
      const app = JSON.parse(read(manifest.scaffold.appManifest))
      // A kit may keep its provenance file in the kit itself with `"app": null` (Rocketflare's
      // `.rocketflare.json`): that is the kit, not a copy, so only the `kit` block is checked.
      isCopy = app.app !== null
      if (isCopy)
        for (const k of ['slug', 'display', 'domain'])
          if (typeof app.app?.[k] !== 'string')
            files.push(`${manifest.scaffold.appManifest}: app.${k} missing`)
      for (const k of ['id', 'version'])
        if (typeof app.kit?.[k] !== 'string')
          files.push(`${manifest.scaffold.appManifest}: kit.${k} missing`)
      if (!(app.kit && 'commit' in app.kit))
        files.push(`${manifest.scaffold.appManifest}: kit.commit missing`)
      if (typeof app.app?.slug === 'string') slug = app.app.slug
    } catch {
      files.push(`${manifest.scaffold.appManifest}: not JSON`)
    }
  }
  add('files', files)

  // ci
  if (exists('.github/workflows/ci.yml')) {
    try {
      const text = read('.github/workflows/ci.yml')
      add('ci', ciProblems(parseYaml(text), text, manifest.ci))
    } catch (err) {
      add('ci', [`ci.yml: ${err.message}`])
    }
  } else add('ci', ['ci.yml: missing'])

  // release
  const releaseFile = `.github/workflows/${manifest.release.workflow}`
  if (exists(releaseFile)) {
    try {
      add(
        'release',
        releaseProblems(parseYaml(read(releaseFile)), {
          file: manifest.release.workflow,
          environmentInput: manifest.release.environmentInput,
        })
      )
    } catch (err) {
      add('release', [`${manifest.release.workflow}: ${err.message}`])
    }
  } else add('release', [`${releaseFile}: missing`])

  // tomls
  const tomlIssues = []
  const parsed = {}
  const { stagingSuffix } = manifest.worker.naming
  for (const env of ['production', 'staging']) {
    const rel = manifest.worker.tomls[env]
    if (!exists(rel)) {
      tomlIssues.push(`${rel}: missing`)
      continue
    }
    try {
      parsed[env] = parseToml(read(rel))
      tomlIssues.push(
        ...tomlProblems(parsed[env], { slug, env, stagingSuffix, provisioned, label: rel })
      )
    } catch (err) {
      tomlIssues.push(`${rel}: ${err.message}`)
    }
  }
  if (parsed.production && parsed.staging) {
    const a = tomlShape(parsed.production, { slug, env: 'production', stagingSuffix })
    const b = tomlShape(parsed.staging, { slug, env: 'staging', stagingSuffix })
    const differ = diffPaths(a, b)
    if (differ.length) tomlIssues.push(`the two tomls differ in shape at: ${differ.join(', ')}`)
  }
  add('tomls', tomlIssues)

  // provides (warnings only)
  const workerDir = path.dirname(manifest.worker.tomls.production)
  const sources = walk(path.join(dir, workerDir, 'src'))
    .filter(f => /\.(ts|tsx|js|mjs)$/.test(f))
    .map(f => readFileSync(path.join(dir, workerDir, 'src', f), 'utf8'))
    .join('\n')
  const p = manifest.launchProvides
  const names = [
    p.appUrl,
    p.databaseUrl,
    p.databaseDriver?.name,
    p.oidc.issuer,
    p.oidc.clientId,
    p.oidc.clientSecret,
    p.oidc.only,
    p.bootstrapAdmins,
    p.emailApiKey,
    p.emailFrom,
    ...p.generated.map(g => g.name),
  ].filter(Boolean)
  for (const name of names) {
    if (!new RegExp(`\\b${name}\\b`).test(sources))
      warnings.push(`launchProvides: ${name} is never read under ${workerDir}/src`)
  }

  // gate-list (opt-in: runs the command)
  if (exec) {
    const problems = []
    const [cmd, ...args] = manifest.ci.gateList.split(/\s+/)
    const res = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' })
    try {
      // `pnpm <script>` prints its own header line first; the document is the outermost {…}.
      const out = String(res.stdout ?? '')
      const list = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
      if (list.schema !== 1) problems.push(`gate list: schema must be 1, got ${list.schema}`)
      const ids = asArray(list.steps).map(s => s?.id)
      for (const s of asArray(list.steps)) {
        if (
          typeof s?.id !== 'string' ||
          typeof s?.command !== 'string' ||
          typeof s?.database !== 'boolean'
        )
          problems.push(`gate list: bad step ${JSON.stringify(s)}`)
      }
      for (const id of GATE_STEPS_LAUNCH_RUNS)
        if (!ids.includes(id))
          problems.push(`gate list: no ${id} step (Launch runs lint, typecheck, test)`)
    } catch {
      problems.push(
        `gate list: \`${manifest.ci.gateList}\` did not print JSON (${res.error ? res.error.message : `exit ${res.status}`})`
      )
    }
    add('gate-list', problems)
  }

  return report(checks, warnings, { id: manifest.kit.id, slug, isCopy })
}

function report(checks, warnings, kit) {
  return { ok: checks.every(c => c.ok), kit, checks, warnings }
}

function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter(a => a.startsWith('-')))
  const unknown = [...flags].filter(
    f => !['--json', '--provisioned', '--exec', '--help', '-h'].includes(f)
  )
  const dirs = argv.filter(a => !a.startsWith('-'))
  if (unknown.length || dirs.length > 1 || flags.has('--help') || flags.has('-h')) {
    console.error('usage: node scripts/kit-check.mjs [dir] [--json] [--provisioned] [--exec]')
    process.exit(flags.has('--help') || flags.has('-h') ? 0 : 2)
  }
  const dir = path.resolve(dirs[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const result = checkKit(dir, {
    provisioned: flags.has('--provisioned'),
    exec: flags.has('--exec'),
  })
  if (flags.has('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    const what = result.kit ? `${result.kit.isCopy ? 'app' : 'kit'} ${result.kit.slug}` : dir
    console.log(`Launch kit check: ${what}`)
    for (const c of result.checks) {
      console.log(`${c.ok ? '✔' : '✖'} ${c.id}`)
      for (const p of c.problems) console.log(`    ${p}`)
    }
    for (const w of result.warnings) console.log(`! ${w}`)
    console.log(
      result.ok ? '✔ conforms to the Launch kit contract (schema 1)' : '✖ does not conform'
    )
  }
  process.exit(result.ok ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
