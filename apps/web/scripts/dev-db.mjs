#!/usr/bin/env node
/**
 * The local dev Postgres, addressed by ONE value: `DATABASE_URL` in `apps/web/.dev.vars`.
 *
 * `docker-compose.dev.yml` used to pin port 5432 and a fixed `container_name`, so a second
 * checkout of the app on the same machine could not start its database at all — it either
 * collided on the port or silently attached to the other checkout's container (compose derives
 * its project name from the directory, and every checkout's is `apps/web`). This script gives
 * each checkout its own project, container and port, and writes the port it chose into
 * `.dev.vars` so every other tool — `db:migrate`, `seed`, `drizzle-kit`, `wrangler dev` — follows
 * without being told.
 *
 *   node scripts/dev-db.mjs up     [--json]   start it (idempotent; prints the port)
 *        [--port <n>]                         on THIS port (or `DEV_DB_PORT=<n>`): taken, or refused
 *                                             with who holds it — never moved
 *        [--neon | --postgres]                also switch the LOCAL driver: `--neon` starts the
 *                                             Neon proxy in front of it and writes NEON_LOCAL_PROXY +
 *                                             DATABASE_DRIVER=neon; `--postgres` stops the proxy.
 *                                             Neither: keep whatever .dev.vars says (missing = postgres)
 *   node scripts/dev-db.mjs down   [--json]   stop THIS checkout's database, never another's
 *   node scripts/dev-db.mjs status [--json]   what is running, where, on which port
 *   node scripts/dev-db.mjs env -- <cmd…>     run <cmd> with DATABASE_URL and the Worker's
 *                                             Hyperdrive override pointing at this database
 *
 * The port is sticky: a re-run keeps the one already in `.dev.vars` whenever it is still ours or
 * still free, so a working database never moves underneath a checkout. A port anyone CHOSE —
 * `--port`, `DEV_DB_PORT`, or a `.dev.vars` port other than the example's — is never moved: when
 * something else holds it, `up` stops and names the holder (`planDevDbPort`). Only a fresh
 * checkout still on the example's port moves, and says why. "Something else" is any running
 * container publishing the port, or a failed bind/connect test on it: a database another project
 * published on one address used to pass the bind test on another and be taken over.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkoutTag,
  chooseDevDbPort,
  databaseUrlPort,
  databaseUrlTarget,
  isLocalDatabaseUrl,
  planDevDbPort,
  publishedHostPorts,
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
const PROXY_SERVICE = 'neon-proxy-dev'
/** The proxy's per-checkout port range (the test proxy holds 4433). */
const PROXY_PORT_START = 4444

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
 * `0.0.0.0` first: compose publishes on the wildcard address, and on macOS a loopback bind
 * SUCCEEDS while Docker holds the same port — which is exactly how a second checkout used to sail
 * past the check and then fail inside `docker compose up`. Then `127.0.0.1`, because the reverse
 * also holds: a server on loopback alone leaves the wildcard bind free.
 */
const bindsOn = (port, host) =>
  new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })

/** True when something accepts a TCP connection on `127.0.0.1:port`. */
const answersOn = port =>
  new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = answer => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

const portIsFree = async port =>
  (await bindsOn(port, '0.0.0.0')) && (await bindsOn(port, '127.0.0.1')) && !(await answersOn(port))

/** Host port → name of every running container publishing it (none without docker). */
function publishedByContainers() {
  const ps = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'])
  return ps.status === 0 ? publishedHostPorts(ps.stdout) : new Map()
}

/**
 * `holderOf` for the planners: null when `port` is this checkout's or free, else who holds it.
 * Probed for exactly the ports asked about (async), then answered synchronously.
 */
async function portHolders(ports) {
  const ours = oursPorts()
  const containers = publishedByContainers()
  const held = new Map()
  for (const p of new Set(ports)) {
    if (!p || ours.has(p)) continue
    if (containers.has(p)) held.set(p, `container ${containers.get(p)}`)
    else if (!(await portIsFree(p))) held.set(p, 'another process')
  }
  return port => held.get(port) ?? null
}

const DEV_DB_RANGE = { start: 5432, count: 20 }
const range = ({ start, count }) => Array.from({ length: count }, (_, i) => start + i)

/** `--port <n>` / `--port=<n>`, else `DEV_DB_PORT` from the environment, else null. */
function requestedPort(argv) {
  const i = argv.findIndex(a => a === '--port' || a.startsWith('--port='))
  const raw =
    i === -1 ? process.env.DEV_DB_PORT : argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1]
  if (raw === undefined || raw === '') return null
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN
}

/** The port `.dev.vars.example` ships — a `.dev.vars` still on it has not chosen one. */
function examplePort() {
  if (!existsSync(DEV_VARS_EXAMPLE)) return 5432
  const url = readDevVars(readFileSync(DEV_VARS_EXAMPLE, 'utf8')).DATABASE_URL
  return (url && databaseUrlPort(url)) || 5432
}

/**
 * The port this checkout should use, and the URL carrying it. Sticky: the port already in
 * `.dev.vars` wins whenever it is still ours or still free; a chosen one is never moved.
 * `strict: false` (status, down) reports a problem instead of exiting on it.
 */
async function resolvePort(argv = [], { strict = true } = {}) {
  const url = currentUrl()
  const preferred = databaseUrlPort(url)
  // An off-box DATABASE_URL (`pnpm bootstrap --db-url`, a Neon branch) is not ours to re-port:
  // hand it through unchanged, and `up` has nothing to start.
  if (!isLocalDatabaseUrl(url)) return { port: preferred, url, moved: false, external: true }
  const requested = requestedPort(argv)
  const pinned = existsSync(DEV_VARS) && preferred !== null && preferred !== examplePort()
  const holderOf = await portHolders([requested, preferred, ...range(DEV_DB_RANGE)])
  const plan = planDevDbPort({ requested, preferred, pinned, holderOf, ...DEV_DB_RANGE })
  if ('error' in plan) {
    if (!strict) return { port: preferred, url, moved: false, problem: plan.error }
    console.error(`dev-db: ${plan.error}`)
    process.exit(1)
  }
  return {
    port: plan.port,
    url: withDatabaseUrlPort(url, plan.port),
    moved: plan.moved,
    reason: plan.reason,
  }
}

/** `.dev.vars` as key → value, or `{}` before the bootstrap has written it. */
function devVars() {
  return existsSync(DEV_VARS) ? readDevVars(readFileSync(DEV_VARS, 'utf8')) : {}
}

/** Persist values in `.dev.vars` so every other tool reads them through dotenv. */
function writeDevVars(values) {
  if (!existsSync(DEV_VARS)) return false
  const text = readFileSync(DEV_VARS, 'utf8')
  let next = text
  for (const [key, value] of Object.entries(values)) next = upsertDevVar(next, key, value)
  if (next === text) return false
  writeFileSync(DEV_VARS, next)
  return true
}

/** The local driver: the flag if one was passed, else `.dev.vars`, else `postgres`. */
function localDriver(argv) {
  if (argv.includes('--neon')) return 'neon'
  if (argv.includes('--postgres')) return 'postgres'
  return devVars().DATABASE_DRIVER === 'neon' ? 'neon' : 'postgres'
}

/** The proxy's port for this checkout: sticky from NEON_LOCAL_PROXY, else the first free one. */
async function resolveProxyPort() {
  const current = devVars().NEON_LOCAL_PROXY
  const preferred = current ? Number(new URL(current).port) || null : null
  const holderOf = await portHolders([preferred, ...range({ start: PROXY_PORT_START, count: 20 })])
  const port = chooseDevDbPort({
    preferred,
    isAvailable: p => holderOf(p) === null,
    start: PROXY_PORT_START,
    count: 20,
    skip: [4433],
  })
  if (port === null) {
    console.error(
      `dev-db: no free port in ${PROXY_PORT_START}–${PROXY_PORT_START + 19} for the Neon proxy`
    )
    process.exit(1)
  }
  return port
}

const composeEnv = (port, url, proxyPort = PROXY_PORT_START) => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  DEV_DB_PORT: String(port),
  DEV_DB_CONTAINER: `rocketflare-dev-postgres-${checkoutTag(WEB_DIR)}`,
  DEV_NEON_PROXY_PORT: String(proxyPort),
  DEV_NEON_PROXY_CONTAINER: `rocketflare-dev-neon-proxy-${checkoutTag(WEB_DIR)}`,
  DATABASE_URL: url,
  [HYPERDRIVE_ENV]: url,
})

async function up(argv, json) {
  const driver = localDriver(argv)
  const { port, url, moved, reason, external } = await resolvePort(argv)
  if (external) {
    // Somebody else's database: under `neon` the driver talks to Neon directly, no proxy.
    writeDevVars({ DATABASE_DRIVER: driver, NEON_LOCAL_PROXY: '' })
    const target = databaseUrlTarget(url)
    if (json) console.log(JSON.stringify({ external: true, target, driver }))
    else {
      console.log(`DATABASE_URL points at ${target} (not this machine) — nothing to start`)
      console.log(`  local driver: ${driver}`)
    }
    return
  }
  const proxyPort = driver === 'neon' ? await resolveProxyPort() : PROXY_PORT_START
  const env = composeEnv(port, url, proxyPort)
  const compose = args =>
    spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
      cwd: WEB_DIR,
      env,
      stdio: json ? 'pipe' : 'inherit',
    })
  // `postgres`: the database alone, and a proxy left over from `--neon` is stopped.
  const result =
    driver === 'neon'
      ? compose(['--profile', 'neon', 'up', '-d', '--wait'])
      : compose(['up', '-d', '--wait', SERVICE])
  if (result.status !== 0) {
    if (json) process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  if (driver === 'postgres') compose(['--profile', 'neon', 'rm', '-sf', PROXY_SERVICE])
  const proxy = driver === 'neon' ? `http://localhost:${proxyPort}` : ''
  const wrote = writeDevVars({
    DATABASE_URL: url,
    DATABASE_DRIVER: driver,
    NEON_LOCAL_PROXY: proxy,
  })
  if (json) {
    console.log(
      JSON.stringify({
        port,
        url,
        project: PROJECT,
        moved,
        ...(reason ? { reason } : {}),
        wroteDevVars: wrote,
        driver,
        proxy,
      })
    )
  } else {
    console.log(`dev database ready on :${port}  (project ${PROJECT})`)
    if (moved) console.log(`  :${port} chosen because ${reason ?? 'the previous port was taken'}`)
    console.log(
      driver === 'neon'
        ? `  local driver: neon, through the Neon proxy on :${proxyPort}`
        : '  local driver: postgres (postgres.js over TCP)'
    )
    if (wrote) console.log('  apps/web/.dev.vars updated to match')
  }
}

async function down(json) {
  const { port, url } = await resolvePort([], { strict: false })
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'neon', 'down'],
    {
      cwd: WEB_DIR,
      env: composeEnv(port, url),
      stdio: json ? 'pipe' : 'inherit',
    }
  )
  if (json) console.log(JSON.stringify({ project: PROJECT, code: result.status ?? 0 }))
  process.exit(result.status ?? 0)
}

/** Every dev database of this app on the machine, whichever checkout started it. */
function allDevDatabases() {
  const ps = sh('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.service=${SERVICE}`,
    '--format',
    '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ])
  if (ps.status !== 0 || !ps.stdout) return [] // no docker (an external-database checkout)
  return ps.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, ports, dir] = line.split('\t')
      return { name, ports, dir, ours: dir === WEB_DIR }
    })
}

async function status(json) {
  const { port, url, external, problem } = await resolvePort([], { strict: false })
  const rows = allDevDatabases()
  if (json) {
    // An external URL carries a real password: report where it points, never the URL itself.
    const where = external ? { external: true, target: databaseUrlTarget(url) } : { port, url }
    const { DATABASE_DRIVER: driver = 'postgres', NEON_LOCAL_PROXY: proxy = '' } = devVars()
    console.log(
      JSON.stringify({
        project: PROJECT,
        ...where,
        driver,
        proxy,
        ...(problem ? { problem } : {}),
        containers: rows,
      })
    )
    return
  }
  const vars = devVars()
  console.log(`this checkout: ${WEB_DIR}`)
  console.log(
    `  local driver: ${vars.DATABASE_DRIVER || 'postgres'}` +
      (vars.NEON_LOCAL_PROXY ? ` (proxy ${vars.NEON_LOCAL_PROXY})` : '')
  )
  if (external)
    console.log(`  external database ${databaseUrlTarget(url)} (pnpm bootstrap --db-url)`)
  else console.log(`  project ${PROJECT} · port ${port}`)
  if (problem) console.log(`  problem: ${problem}`)
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
if (command === 'up') await up(argv, json)
else if (command === 'down') await down(json)
else if (command === 'status') await status(json)
else if (command === 'env') await env(argv)
else {
  console.error(`dev-db: unknown command "${command}" (up | down | status | env -- <cmd>)`)
  process.exit(2)
}
