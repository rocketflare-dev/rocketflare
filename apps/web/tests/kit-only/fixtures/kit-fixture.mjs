/**
 * A self-contained Launch kit for the conformance checker's tests (scripts/kit-check.mjs): every
 * file the checker reads, built from scratch in a temp directory. Never this repository's own
 * files: an app made from the kit renames them, provisions its tomls and edits its workflows, and a
 * test that judged them would fail there for doing exactly what an app does. "Does THIS repository
 * conform" is a CI step of the kit's own workflow (kit.yml), never a test.
 *
 * - `writeKitFixture(dir, { app })` — the kit (`app` null) or a fresh copy of it (`app` = the
 *   copy's `{ slug, display, domain }`): names from the slug, every KV id a `<PLACEHOLDER>`.
 * - `provisionLikeLaunch(dir, …)` — what Launch's `write_config` step commits into a copy's two
 *   tomls (rocketflare-launch `services/launch/kits/toml.ts` `writeConfig`): every KV id real, the
 *   app URL, Launch's sign-in vars under a comment, `workers_dev = false`, no `[[hyperdrive]]`
 *   HYPERDRIVE block. It writes no route (Launch owns the hostnames) and no secret.
 *
 * SHARED with the Rocketflare kit (`apps/web/tests/kit-only/fixtures/kit-fixture.mjs` there) and the
 * meta-kit (`scripts/tests/fixtures/kit-fixture.mjs`): change both together. Node built-ins only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const FIXTURE_TOKENS = { slug: 'acme-kit', display: 'Acme Kit', domain: 'acme-kit.dev' }
export const FIXTURE_APP_MANIFEST = '.launch-app.json'
export const FIXTURE_TOMLS = ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']

/** A valid `launch.kit.json` (schema 1) for the fixture kit. */
export function fixtureManifest() {
  return {
    schema: 1,
    kit: {
      id: FIXTURE_TOKENS.slug,
      name: FIXTURE_TOKENS.display,
      description: 'A kit built by the conformance checker tests.',
      version: { file: 'package.json', field: 'version' },
      tagPattern: '^\\d+\\.\\d+\\.\\d+$',
    },
    scaffold: {
      init: 'node scripts/init.mjs {slug} {display} --domain {domain} --force',
      kitOnly: ['.github/workflows/kit.yml'],
      postInit: ['pnpm install --no-frozen-lockfile', 'pnpm lint:fix'],
      appManifest: FIXTURE_APP_MANIFEST,
      tokens: { ...FIXTURE_TOKENS },
    },
    worker: {
      tomls: { production: FIXTURE_TOMLS[0], staging: FIXTURE_TOMLS[1] },
      naming: { pattern: '{slug}-{suffix}', stagingSuffix: '-staging' },
    },
    launchProvides: {
      appUrl: 'APP_URL',
      databaseUrl: 'DATABASE_URL',
      databaseDriver: { name: 'DATABASE_DRIVER', value: 'neon' },
      oidc: {
        issuer: 'OIDC_ISSUER',
        clientId: 'OIDC_CLIENT_ID',
        clientSecret: 'OIDC_CLIENT_SECRET',
        only: 'AUTH_OIDC_ONLY',
      },
      bootstrapAdmins: 'BOOTSTRAP_ADMIN_EMAILS',
      generated: [{ name: 'SESSION_SECRET', kind: 'hex64' }],
      vars: {},
    },
    declaredConfig: { optional: [] },
    database: {
      roles: { migrator: 'migrator', app: 'app' },
      extensions: [],
      migrate: 'pnpm db:migrate',
    },
    health: { live: '/api/health', ready: '/api/ready' },
    ci: {
      requiredCheck: 'Gate',
      gateList: 'node scripts/gate.mjs --list --json',
      gateRun: 'node scripts/gate.mjs {step}',
      verifiedVariable: 'LAUNCH_GATE_APP_ID',
    },
    release: { workflow: 'deploy.yml', environmentInput: 'environment', deployerProtocol: 1 },
    session: {
      install: 'pnpm install --frozen-lockfile',
      bootstrap: 'node scripts/bootstrap.mjs --db-url {dbUrl}',
      devStart: 'node scripts/dev.mjs start',
      devStop: 'node scripts/dev.mjs stop',
      ports: { ui: 'DEV_UI_PORT', api: 'DEV_API_PORT', allowedHosts: 'DEV_ALLOWED_HOSTS' },
      writes: ['apps/web/.dev.vars'],
      env: { skip: 'KIT_BOOTSTRAP_SKIP', allowRoot: 'KIT_ALLOW_ROOT' },
    },
    upgrade: {
      command: 'node scripts/upgrade.mjs --to {to} --apply',
      skill: '.claude/skills/upgrade/SKILL.md',
      notes: 'docs/upgrades/{version}.md',
      doneMarker: 'LAUNCH-UPGRADE:',
    },
  }
}

const GATE_LIST = {
  schema: 1,
  steps: ['lint', 'typecheck', 'test', 'build'].map(id => ({
    id,
    command: `pnpm ${id}`,
    database: id === 'test',
  })),
}

const CI_YML = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  gate:
    name: Gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verified by Launch?
        if: vars.LAUNCH_GATE_APP_ID != ''
        run: node scripts/gate-verified.mjs
      - run: node scripts/gate.mjs
`

const deployJob = env => `  ${env}:
    name: Deploy to ${env}
    runs-on: ubuntu-latest
    environment: ${env}
    permissions:
      contents: read
      id-token: write
    env:
      DEPLOYER_URL: \${{ vars.DEPLOYER_URL }}
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/deployer.mjs start
      - run: node scripts/deployer.mjs upload
      - run: node scripts/deployer.mjs activate
      - name: Tell the deployer the deploy is over
        if: always() && vars.DEPLOYER_URL != ''
        run: node scripts/deployer.mjs finish
`

export const FIXTURE_DEPLOY_YML = `name: Deploy
on:
  push:
    tags:
      - "[0-9]+.[0-9]+.[0-9]+"
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
jobs:
${deployJob('staging')}${deployJob('production')}`

/** One environment's toml, as the kit (or a fresh copy) commits it. */
function toml({ slug, domain, display }, env) {
  const s = env === 'staging' ? '-staging' : ''
  const ID = env === 'staging' ? '_STAGING' : ''
  return `# The ${env} Worker (a fixture).
name = "${slug}${s}"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[vars]
APP_ENV = "${env}"
APP_URL = "https://${slug}${s}.${domain}"
APP_NAME = "${display}"
DATABASE_DRIVER = "neon"
AUTH_OIDC_ONLY = "true"

[observability]
enabled = true

[assets]
directory = "./dist/ui"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/auth/*"]

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<RATE_LIMIT_KV${ID}_ID>"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "<CACHE_KV${ID}_ID>"

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "${slug}-jobs${s}"

[[queues.consumers]]
queue = "${slug}-jobs${s}"
max_batch_size = 10

[[r2_buckets]]
binding = "FILES"
bucket_name = "${slug}-files${s}"
`
}

const WORKER_TS = `// Reads every var launchProvides names, so the checker's provides check has no warning.
export const NAMES = [
  'APP_URL', 'DATABASE_URL', 'DATABASE_DRIVER', 'OIDC_ISSUER', 'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET', 'AUTH_OIDC_ONLY', 'BOOTSTRAP_ADMIN_EMAILS', 'SESSION_SECRET',
]
`

/**
 * Write the fixture kit into `dir` (an empty directory). `app` null: the kit itself; an object: a
 * fresh copy named `{ slug, display, domain }`, with the app manifest Launch's scaffold leaves.
 */
export function writeKitFixture(dir, { app = null } = {}) {
  const names = app ?? FIXTURE_TOKENS
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  write('launch.kit.json', `${JSON.stringify(fixtureManifest(), null, 2)}\n`)
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: names.slug,
        version: app ? '0.1.0' : '1.0.0',
        private: true,
        scripts: { 'lint:fix': 'true', 'db:migrate': 'true' },
      },
      null,
      2
    )}\n`
  )
  write('CLAUDE.md', '# The fixture kit\n')
  for (const s of ['init', 'bootstrap', 'dev', 'upgrade', 'gate-verified', 'deployer'])
    write(`scripts/${s}.mjs`, '')
  write(
    'scripts/gate.mjs',
    `if (process.argv.includes('--list')) console.log(${JSON.stringify(JSON.stringify(GATE_LIST))})\n`
  )
  write('.claude/skills/upgrade/SKILL.md', '# upgrade\n')
  write('.github/workflows/ci.yml', CI_YML)
  write('.github/workflows/deploy.yml', FIXTURE_DEPLOY_YML)
  write(FIXTURE_TOMLS[0], toml(names, 'production'))
  write(FIXTURE_TOMLS[1], toml(names, 'staging'))
  write('apps/web/src/worker.ts', WORKER_TS)
  if (app) {
    write(
      FIXTURE_APP_MANIFEST,
      `${JSON.stringify(
        {
          app,
          kit: { id: FIXTURE_TOKENS.slug, version: '1.0.0', commit: '0'.repeat(40) },
        },
        null,
        2
      )}\n`
    )
  } else write('.github/workflows/kit.yml', 'name: Kit\non:\n  push:\njobs: {}\n')
  return dir
}

const hex32 = seed =>
  Array.from({ length: 32 }, (_, i) => ((seed * 7 + i) % 16).toString(16)).join('')

/**
 * Launch's `write_config` over a copy's two tomls, byte-preserving like Launch's patcher, with the
 * names the copy's own `launch.kit.json` gives (so it runs on the fixture and on a real copy alike —
 * kit.yml provisions its scaffolded copy with it): every KV `<PLACEHOLDER>` id a real 32-hex id,
 * the app URL (and sender, when the kit has one), the kit's fixed `launchProvides.vars`, the
 * database driver, Launch's sign-in vars (added under Launch's comment when absent),
 * `workers_dev = false` after `name`, and any `[[hyperdrive]]` block binding HYPERDRIVE dropped.
 * Returns the ids it wrote.
 */
export function provisionLikeLaunch(
  dir,
  {
    domain = 'apps.example.com',
    issuer = 'https://launch.example.com',
    clientId = 'lc_fixtureclient',
  } = {}
) {
  const read = rel => readFileSync(path.join(dir, rel), 'utf8')
  const manifest = JSON.parse(read('launch.kit.json'))
  const p = manifest.launchProvides
  const app = JSON.parse(read(manifest.scaffold.appManifest)).app
  const ids = []
  for (const env of ['production', 'staging']) {
    const rel = manifest.worker.tomls[env]
    const suffix = env === 'staging' ? (manifest.worker.naming?.stagingSuffix ?? '-staging') : ''
    let text = read(rel)
    text = text.replace(/\n\[\[hyperdrive\]\]\nbinding = "HYPERDRIVE"\n(?:[^\n[]+\n)*/g, '\n')
    text = text.replace(/^(id\s*=\s*")<[A-Z0-9_]+>(")/gm, (_, a, b) => {
      const id = hex32(ids.length + 1)
      ids.push(id)
      return `${a}${id}${b}`
    })
    const patch = (key, value) => {
      const re = new RegExp(`^${key} = "[^"]*"`, 'm')
      if (!re.test(text)) return false
      text = text.replace(re, `${key} = "${value}"`)
      return true
    }
    patch(p.appUrl, `https://${app.slug}${suffix}.${domain}`)
    if (p.emailFrom) patch(p.emailFrom, `${app.display} <noreply@${domain}>`)
    const vars = [
      ...(p.databaseDriver ? [[p.databaseDriver.name, p.databaseDriver.value]] : []),
      ...Object.entries(p.vars ?? {}),
      [p.oidc.issuer, issuer],
      [p.oidc.clientId, clientId],
      ...(p.oidc.label ? [[p.oidc.label, 'Sign in with Launch']] : []),
      ...(p.oidc.only ? [[p.oidc.only, 'true']] : []),
    ]
    const missing = vars
      .filter(([key, value]) => !patch(key, value))
      .map(([k, v]) => `${k} = "${v}"`)
    if (missing.length) {
      const lines = text.split('\n')
      let last = lines.findIndex(l => l.trim() === '[vars]')
      for (let i = last + 1; i < lines.length && !lines[i].startsWith('['); i++)
        if (/^[A-Z_][A-Z0-9_]*\s*=/.test(lines[i])) last = i
      lines.splice(
        last + 1,
        0,
        '# Launch (spec/05): sign-in goes through Launch, the OIDC issuer this app is registered with.',
        `# Written by Launch; the client secret is the ${p.oidc.clientSecret} Worker secret.`,
        ...missing
      )
      text = lines.join('\n')
    }
    const note =
      '# Launch routes this app to its own host (spec/04), so there is no workers.dev host.'
    if (/^workers_dev\s*=/m.test(text))
      text = text.replace(
        /^(?:# Fallback host[^\n]*\n)?workers_dev\s*=.*$/m,
        `${note}\nworkers_dev = false`
      )
    else text = text.replace(/^(name = "[^"]*"\n)/m, `$1\n${note}\nworkers_dev = false\n`)
    writeFileSync(path.join(dir, rel), text)
  }
  return ids
}
