#!/usr/bin/env node
/**
 * `pnpm test` — the one full test run, and the `test` step of `pnpm gate`. What it runs, and on
 * which target, is decided in `scripts/lib/test-plan.mjs`; this file prints the target, starts the
 * compose database when the target is local, and runs the steps in order, stopping at the first
 * that fails.
 *
 * `pnpm test <suite…> [file…]` is the inner loop: `api`, `ui`, `config`, `driver` (and `kit-only`
 * in the kit), each its shared and isolated vitest projects together, narrowed to any file paths or
 * filters given, under the suite driver. A path alone runs it in whichever project holds it.
 * `pnpm test web` is the full plan without the other packages. The `apps/web` `test:*` scripts
 * are one-line aliases for these, so no `package.json` names a vitest project.
 *
 * `--changed=<base>` (what `pnpm gate --changed` runs) narrows the run to the tests the change
 * reaches: vitest's import graph, plus every test that reads the repository through the
 * filesystem (`lib/gate-changed.mjs`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planChanged, readsFiles, selectTests } from './lib/gate-changed.mjs'
import { changedFiles, workspacePackages } from './lib/gate-changed-git.mjs'
import {
  COMPOSE_FILE,
  planSelectedTests,
  planSuites,
  planTests,
  SUITES,
  TARGET_HINT,
  WEB_DIR,
} from './lib/test-plan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(command, { cwd = ROOT, env = {}, quiet = false } = {}) {
  const [bin, ...args] = command
  const result = spawnSync(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: quiet ? 'ignore' : 'inherit',
  })
  return result.status ?? 1
}

function fail(message) {
  console.error(`\n✖ pnpm test: ${message}`)
  process.exit(1)
}

/** stdout of a command, or null when it fails. */
function capture(command) {
  const [bin, ...args] = command
  const result = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

// vitest under an older Node dies on startup with `code.charCodeAt is not a function` — Vite's
// source-map handler failing on the real error — which says nothing about the cause.
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 26) {
  fail(
    `Node ${process.versions.node} is on PATH; the kit needs Node 26 (\`nvm use\` reads .nvmrc).`
  )
}

/** The container publishing `port`, or null. */
function holderOf(port) {
  const out = capture(['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'])
  return out ? out.split('\n')[0] : null
}

/**
 * Another checkout's test containers already hold the ports (every copy of the kit uses :5433 and
 * :4433): reuse them instead of failing `compose up`, and give this checkout its own database
 * there, named by its `.env.test`. Returns true when the shared servers are in use.
 */
function reuseSharedTestServers() {
  const compose = readFileSync(path.join(ROOT, COMPOSE_FILE), 'utf8')
  const ours = new Set([...compose.matchAll(/container_name:\s*(\S+)/g)].map(m => m[1]))
  const pg = holderOf(5433)
  const proxy = holderOf(4433)
  if ((!pg || ours.has(pg)) && (!proxy || ours.has(proxy))) return false
  if (!pg || !proxy) {
    fail(
      `:5433 is held by ${pg ?? 'nothing'} and :4433 by ${proxy ?? 'nothing'} — another checkout's ` +
        'test containers are half up. `pnpm dev:db:status` lists them; start or stop that pair.'
    )
  }
  const envTest = readFileSync(path.join(ROOT, WEB_DIR, '.env.test'), 'utf8')
  const url = new URL(/^DATABASE_URL=(\S+)/m.exec(envTest)?.[1] ?? '')
  const db = url.pathname.slice(1)
  const user = decodeURIComponent(url.username)
  if (!/^[a-z0-9_]+$/.test(db)) fail(`.env.test DATABASE_URL names an odd database "${db}"`)
  const psql = sql => ['docker', 'exec', pg, 'psql', '-U', user, '-d', 'postgres', '-tAc', sql]
  const exists = capture(psql(`select 1 from pg_database where datname = '${db}'`))
  if (exists === null) {
    fail(
      `cannot reach Postgres in ${pg} as ${user} — is it another app's test server with other credentials?`
    )
  }
  if (exists !== '1' && run(psql(`create database ${db}`), { quiet: true }) !== 0) {
    fail(`could not create database ${db} in ${pg}`)
  }
  console.log(
    `· test servers: reusing ${pg} + ${proxy}; database ${db}${exists === '1' ? '' : ' (created)'}`
  )
  return true
}

/** `vitest list --filesOnly --json` in apps/web, as repo-relative `{ file, project }`. */
function vitestList(extra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rf-gate-list-'))
  const out = path.join(dir, 'list.json')
  const args = ['exec', 'dotenv', '-e', '.env.test', '--', 'vitest', 'list', '--filesOnly']
  return new Promise(resolve => {
    const child = spawn('pnpm', [...args, `--json=${out}`, ...extra], {
      cwd: path.join(ROOT, WEB_DIR),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('close', code => {
      const list = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
      rmSync(dir, { recursive: true, force: true })
      if (code !== 0 || !list) fail(`vitest list failed:\n${stderr.slice(-2000)}`)
      resolve(list.map(t => ({ file: path.relative(ROOT, t.file), project: t.projectName })))
    })
  })
}

/** Test helpers that read the filesystem: a test importing one reads the repository too. */
function fsHelpers() {
  const out = []
  for (const sub of ['tests/helpers', 'tests/kit']) {
    const dir = path.join(ROOT, WEB_DIR, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue
      if (readsFiles(readFileSync(path.join(dir, f), 'utf8'))) {
        out.push(`${sub.split('/')[1]}/${f.replace(/\.tsx?$/, '')}`)
      }
    }
  }
  return out
}

async function changedPlan(base) {
  const { changed, existing } = changedFiles(ROOT, base)
  const decided = planChanged({ changed, existing, packages: workspacePackages(ROOT) })
  if ('full' in decided) {
    console.log(`· ${decided.full} — running every test`)
    return null
  }
  let projects = {}
  if (decided.test.web) {
    const [all, related] = await Promise.all([vitestList([]), vitestList([`--changed=${base}`])])
    const sources = Object.fromEntries(
      [...new Set(all.map(t => t.file))].map(f => [f, readFileSync(path.join(ROOT, f), 'utf8')])
    )
    const chosen = selectTests({ all, related, sources, changed, fsHelpers: fsHelpers() })
    // vitest runs in apps/web: hand it absolute paths, which match exactly one file each.
    projects = Object.fromEntries(
      Object.entries(chosen).map(([p, files]) => [p, files.map(f => path.join(ROOT, f))])
    )
  }
  return planSelectedTests(process.env, { projects, packages: decided.test.packages })
}

const argv = process.argv.slice(2)
const changedArg = argv.find(a => a.startsWith('--changed='))
const kitOnly = existsSync(path.join(ROOT, WEB_DIR, 'tests/kit-only'))
// Paths arrive relative to the caller (`pnpm web test:api tests/api/x.test.ts` runs in apps/web,
// `pnpm test api apps/web/tests/api/x.test.ts` at the root); vitest runs in apps/web, so an
// existing path is handed over absolute. Anything else is a vitest name filter, passed as given.
const callerDir = process.env.INIT_CWD ?? process.cwd()
const positional = argv.filter(a => !a.startsWith('--changed'))
const suites = positional.filter(a => a in SUITES)
const files = positional
  .filter(a => !(a in SUITES) && a !== 'web')
  .map(a => (existsSync(path.resolve(callerDir, a)) ? path.resolve(callerDir, a) : a))
const plan =
  (changedArg && (await changedPlan(changedArg.slice('--changed='.length)))) ||
  (positional.length === 1 && positional[0] === 'web'
    ? planTests(process.env, { kitOnly, webOnly: true })
    : positional.length
      ? planSuites(process.env, { suites, files, kitOnly })
      : planTests(process.env, { kitOnly }))
if ('error' in plan) fail(plan.error)

console.log(plan.banner)

if (plan.compose) {
  if (run(['docker', 'info'], { quiet: true }) !== 0) {
    fail(`Docker is not running, and a local target needs it. ${TARGET_HINT}`)
  }
  // `--wait` blocks until both health checks pass; a no-op when they are already up. Never torn
  // down: the next run reuses it, and `pnpm test:db:down` is there for whoever wants it gone.
  const up = reuseSharedTestServers()
    ? 0
    : run(['docker', 'compose', '-f', COMPOSE_FILE, '--profile', 'neon', 'up', '-d', '--wait'], {
        quiet: false,
      })
  if (up !== 0) {
    fail(
      'the test database did not start (docker compose up failed above). Another checkout holding ' +
        ':5433 or :4433 is the usual cause: `pnpm dev:db:status` lists them.'
    )
  }
}

for (const step of plan.steps) {
  console.log(`\n▶ ${step.label}`)
  const status = run(step.command, { cwd: path.join(ROOT, step.cwd), env: step.env })
  if (status !== 0) fail(`${step.label} failed`)
}
for (const note of plan.notes) console.log(`\n· ${note}`)
console.log(`\n✔ pnpm test: ${plan.steps.length} step(s) passed (${plan.target})`)
