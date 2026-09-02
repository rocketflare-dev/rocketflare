#!/usr/bin/env node
/**
 * The local dev Postgres, addressed by ONE value: `DATABASE_URL` in `apps/web/.dev.vars`.
 *
 * `docker-compose.dev.yml` used to pin port 5432 and a fixed `container_name`, so a second
 * checkout of the kit on the same machine could not start its database at all — it either
 * collided on the port or silently attached to the other checkout's container (compose derives
 * its project name from the directory, and every checkout's is `apps/web`). This script gives
 * each checkout its own project, container and port, and writes the port it chose into
 * `.dev.vars` so every other tool — `db:migrate`, `seed`, `drizzle-kit`, `wrangler dev` — follows
 * without being told.
 *
 *   node scripts/dev-db.mjs up     [--json]   start it (idempotent; prints the port)
 *   node scripts/dev-db.mjs down   [--json]   stop THIS checkout's database, never another's
 *   node scripts/dev-db.mjs status [--json]   what is running, where, on which port
 *   node scripts/dev-db.mjs env -- <cmd…>     run <cmd> with DATABASE_URL and the Worker's
 *                                             Hyperdrive override pointing at this database
 *
 * The port is sticky: a re-run keeps the one already in `.dev.vars` whenever it is still ours or
 * still free, so a working database never moves underneath a checkout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkoutTag,
  chooseDevDbPort,
  databaseUrlPort,
  readDevVars,
  upsertDevVar,
  withDatabaseUrlPort,
} from '../../../scripts/lib/bootstrap-lib.mjs'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_FILE = path.join(WEB_DIR, 'docker-compose.dev.yml')
const DEV_VARS = path.join(WEB_DIR, '.dev.vars')
const DEV_VARS_EXAMPLE = path.join(WEB_DIR, '.dev.vars.example')
/** Wrangler reads this for the local Hyperdrive binding; the toml's value is only a fallback. */
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const SERVICE = 'postgres-dev'

/** This checkout's compose project — unique per path, so two checkouts never share containers. */
const PROJECT = `rocketflare-dev-${checkoutTag(WEB_DIR)}`

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd: WEB_DIR, ...opts })

/** The DATABASE_URL a fresh checkout starts from (.dev.vars, else the example). */
function currentUrl() {
  for (const file of [DEV_VARS, DEV_VARS_EXAMPLE]) {
    if (!existsSync(file)) continue
    const url = readDevVars(readFileSync(file, 'utf8')).DATABASE_URL
    if (url) return url
  }
  return 'postgresql://rocketflare:rocketflare_pass@localhost:5432/rocketflare_dev'
}

/** Every port published by a container of THIS checkout's compose project. */
function oursPorts() {
  const ps = sh('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', 'json'])
  if (ps.status !== 0) return new Set()
  const ports = new Set()
  for (const line of ps.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      for (const p of JSON.parse(line).Publishers ?? []) {
        if (p.PublishedPort) ports.add(Number(p.PublishedPort))
      }
    } catch {
      /* a docker version that prints something else: fall through to the free-port test */
    }
  }
  return ports
}

/**
 * `0.0.0.0`, not `127.0.0.1`: compose publishes on the wildcard address, and on macOS a
 * loopback bind SUCCEEDS while Docker holds the same port — which is exactly how a second
 * checkout used to sail past the check and then fail inside `docker compose up`.
 */
const portIsFree = port =>
  new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '0.0.0.0')
  })

/**
 * The port this checkout should use, and the URL carrying it. Sticky: the port already in
 * `.dev.vars` wins whenever it is still ours or still free.
 */
async function resolvePort() {
  const url = currentUrl()
  const preferred = databaseUrlPort(url)
  const ours = oursPorts()
  const free = new Map()
  for (let p = 5432; p < 5452; p += 1) free.set(p, await portIsFree(p))
  const isAvailable = port => ours.has(port) || free.get(port) === true
  const port = chooseDevDbPort({ preferred, isAvailable })
  if (port === null) {
    console.error('dev-db: no free port in 5432–5451 for the dev database')
    process.exit(1)
  }
  return {
    port,
    url: withDatabaseUrlPort(url, port),
    moved: preferred !== null && port !== preferred,
  }
}

/** Persist the port in `.dev.vars` so every other tool reads it through dotenv. */
function writeUrl(url) {
  if (!existsSync(DEV_VARS)) return false
  const text = readFileSync(DEV_VARS, 'utf8')
  const next = upsertDevVar(text, 'DATABASE_URL', url)
  if (next === text) return false
  writeFileSync(DEV_VARS, next)
  return true
}

const composeEnv = (port, url) => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  DEV_DB_PORT: String(port),
  DEV_DB_CONTAINER: `rocketflare-dev-postgres-${checkoutTag(WEB_DIR)}`,
  DATABASE_URL: url,
  [HYPERDRIVE_ENV]: url,
})

async function up(json) {
  const { port, url, moved } = await resolvePort()
  const wrote = writeUrl(url)
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'up', '-d', '--wait'],
    { cwd: WEB_DIR, env: composeEnv(port, url), stdio: json ? 'pipe' : 'inherit' }
  )
  if (result.status !== 0) {
    if (json) process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  if (json) {
    console.log(JSON.stringify({ port, url, project: PROJECT, moved, wroteDevVars: wrote }))
  } else {
    console.log(`dev database ready on :${port}  (project ${PROJECT})`)
    if (moved)
      console.log(`  :${port} chosen because the previous port was taken by something else`)
    if (wrote) console.log('  DATABASE_URL in apps/web/.dev.vars updated to match')
  }
}

async function down(json) {
  const { port, url } = await resolvePort()
  const result = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'down'], {
    cwd: WEB_DIR,
    env: composeEnv(port, url),
    stdio: json ? 'pipe' : 'inherit',
  })
  if (json) console.log(JSON.stringify({ project: PROJECT, code: result.status ?? 0 }))
  process.exit(result.status ?? 0)
}

/** Every dev database of this kit on the machine, whichever checkout started it. */
function allDevDatabases() {
  const ps = sh('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.service=${SERVICE}`,
    '--format',
    '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ])
  return ps.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, ports, dir] = line.split('\t')
      return { name, ports, dir, ours: dir === WEB_DIR }
    })
}

async function status(json) {
  const { port, url } = await resolvePort()
  const rows = allDevDatabases()
  if (json) {
    console.log(JSON.stringify({ project: PROJECT, port, url, containers: rows }))
    return
  }
  console.log(`this checkout: ${WEB_DIR}`)
  console.log(`  project ${PROJECT} · port ${port}`)
  if (rows.length === 0) {
    console.log('  no dev Postgres container is running')
    return
  }
  console.log('running dev databases on this machine:')
  for (const row of rows) {
    console.log(`  ${row.ours ? '*' : ' '} ${row.name}  ${row.ports}  ${row.dir}`)
  }
}

/** `env -- <cmd…>`: run a child against this checkout's database. */
async function env(argv) {
  const rest = argv.slice(argv.indexOf('--') + 1)
  if (argv.indexOf('--') === -1 || rest.length === 0) {
    console.error('usage: node scripts/dev-db.mjs env -- <command> [args…]')
    process.exit(2)
  }
  const { port, url } = await resolvePort()
  const child = spawn(rest[0], rest.slice(1), {
    cwd: process.cwd(),
    env: composeEnv(port, url),
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
}

const argv = process.argv.slice(2)
const command = argv[0] ?? 'up'
const json = argv.includes('--json')
if (command === 'up') await up(json)
else if (command === 'down') await down(json)
else if (command === 'status') await status(json)
else if (command === 'env') await env(argv)
else {
  console.error(`dev-db: unknown command "${command}" (up | down | status | env -- <cmd>)`)
  process.exit(2)
}
