#!/usr/bin/env node
/**
 * `pnpm test` — the one full test run, and the `test` step of `pnpm gate`. What it runs, and on
 * which target, is decided in `scripts/lib/test-plan.mjs`; this file prints the target, starts the
 * compose database when the target is local, and runs the steps in order, stopping at the first
 * that fails.
 *
 * The inner loop is the narrow scripts (`pnpm web test:api`, `test:ui`, `test:config`,
 * `test:driver`, or a vitest file path): postgres, no compose management.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSE_FILE, planTests, TARGET_HINT, WEB_DIR } from './lib/test-plan.mjs'

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

const plan = planTests(process.env, {
  kitOnly: existsSync(path.join(ROOT, WEB_DIR, 'tests/kit-only')),
})
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
