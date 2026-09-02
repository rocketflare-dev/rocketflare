#!/usr/bin/env node
/**
 * The local dev stack: `wrangler dev` (:3001) + Vite (:3000), supervised here instead of by
 * `concurrently` — two children of ONE node process is a tree that can actually be killed, and it
 * lets us own the output. Modes:
 *
 *   --start       (`pnpm dev`) preflight, then run both servers: a spinner while they boot, then
 *                 one ready line with the Vite URL, then only what matters (app logs, warnings,
 *                 errors). `DEV_VERBOSE=1` or `--verbose` prints every raw line instead; the
 *                 unfiltered servers are still one command away (`pnpm dev:api` / `pnpm dev:ui`).
 *   --preflight   clear THIS repo's leftover dev processes, then refuse to start if something
 *                 else still holds :3000/:3001 — a loud failure beats two servers fighting over
 *                 a port (Vite is `strictPort`, so it cannot quietly land on the API's).
 *   --stop        (`pnpm dev:stop`) kill the whole tree, supervisor FIRST, looping until quiet:
 *                 a supervisor that restarts children can respawn one between passes, and
 *                 `workerd` ignores SIGTERM often enough to need SIGKILL.
 *   --status      (`pnpm dev:status`) print what is running and who holds the ports; no signals.
 *
 * Ownership is deliberate: a process counts as ours only when its command line or its cwd is
 * inside THIS repository. Another checkout (or another app) on :3001 is reported, never killed.
 * `ps`/`lsof` only — no pidfile to go stale, no dependency to install.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevVars } from '../../../scripts/lib/bootstrap-lib.mjs'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(WEB_DIR, '../..')
const PORTS = [3000, 3001]
/**
 * The dev stack's process names; anything else in the repo is left alone. Only `--start` matches:
 * a `--stop` / `--status` run must never be a target of another instance's sweep.
 */
const DEV_COMMAND =
  /(dev-server\.mjs --start|concurrently|vite\/bin\/vite|wrangler\/bin\/wrangler|wrangler dev|workerd)/
const GRACE_MS = 3000
/** Passes over the tree: a restarting supervisor can respawn children between passes. */
const MAX_STOP_PASSES = 6

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return '' // lsof exits 1 with no matches; ps never should, but silence is the right answer
  }
}

/** Every process as `{ pid, ppid, command }`. */
function processTable() {
  return run('ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(m => m !== null)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
}

/** A process's working directory, or '' when it cannot be read (another user, gone already). */
function cwdOf(pid) {
  const line = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find(l => l.startsWith('n'))
  return line ? line.slice(1) : ''
}

const inRepo = p => p.startsWith(`${REPO_ROOT}/`) || p === REPO_ROOT

/** pids listening on the dev ports, `{ port, pid }`. */
function portHolders() {
  const out = []
  for (const port of PORTS) {
    const pids = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      .split('\n')
      .map(s => Number(s.trim()))
      .filter(Boolean)
    for (const pid of new Set(pids)) out.push({ port, pid })
  }
  return out
}

/** The pids we must never signal: this script and everything that started it. */
function selfAncestry(table) {
  const byPid = new Map(table.map(p => [p.pid, p]))
  const safe = new Set([process.pid])
  let cursor = byPid.get(process.pid)?.ppid
  while (cursor && cursor > 1 && !safe.has(cursor)) {
    safe.add(cursor)
    cursor = byPid.get(cursor)?.ppid
  }
  return safe
}

/**
 * This repo's dev processes: the stack commands whose command line or cwd is in the repo, plus
 * every descendant of those (the `sh -c … wrangler dev` wrapper, esbuild and workerd children
 * carry no repo path of their own).
 */
function ownDevProcesses(table, holders) {
  const safe = selfAncestry(table)
  const owned = new Map()
  for (const p of table) {
    if (safe.has(p.pid) || !DEV_COMMAND.test(p.command)) continue
    if (p.command.includes(REPO_ROOT) || inRepo(cwdOf(p.pid))) owned.set(p.pid, p)
  }
  // A port holder inside the repo counts even if its command line looks unfamiliar.
  for (const { pid } of holders) {
    if (owned.has(pid) || safe.has(pid)) continue
    const proc = table.find(p => p.pid === pid)
    if (proc && (proc.command.includes(REPO_ROOT) || inRepo(cwdOf(pid)))) owned.set(pid, proc)
  }
  // Descendants, breadth-first — children of an owned process are ours too.
  for (let added = true; added; ) {
    added = false
    for (const p of table) {
      if (!owned.has(p.pid) && owned.has(p.ppid) && !safe.has(p.pid)) {
        owned.set(p.pid, p)
        added = true
      }
    }
  }
  return [...owned.values()]
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const short = (command, width = 90) =>
  (command.startsWith(REPO_ROOT) ? `…${command.slice(REPO_ROOT.length)}` : command).slice(0, width)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Parents before children, so `concurrently` cannot restart a child we already killed. */
function killOrder(procs) {
  const depth = p => {
    let d = 0
    let cursor = p
    const byPid = new Map(procs.map(x => [x.pid, x]))
    while (cursor && byPid.has(cursor.ppid) && d < 20) {
      cursor = byPid.get(cursor.ppid)
      d += 1
    }
    return d
  }
  return [...procs].sort((a, b) => depth(a) - depth(b))
}

async function stop({ quiet = false } = {}) {
  // Repeat until the repo is quiet: `concurrently` runs with `--restart-tries`, so between the
  // signal to it and its death it can respawn a child we already killed. One pass would leave
  // those orphans holding the ports — the exact flakiness this script exists to remove.
  let killed = 0
  for (let pass = 0; pass < MAX_STOP_PASSES; pass += 1) {
    const procs = killOrder(ownDevProcesses(processTable(), portHolders()))
    if (procs.length === 0) break
    // Polite once; anything still there on a later pass (workerd, respawned children) is killed.
    const signal = pass === 0 ? 'SIGTERM' : 'SIGKILL'
    for (const p of procs) {
      if (!quiet) console.log(`dev: ${signal} ${p.pid}  ${short(p.command)}`)
      try {
        process.kill(p.pid, signal)
      } catch {}
      killed += 1
    }
    const deadline = Date.now() + (pass === 0 ? GRACE_MS : 500)
    while (Date.now() < deadline && procs.some(p => alive(p.pid))) await sleep(150)
  }
  const left = ownDevProcesses(processTable(), portHolders())
  if (left.length > 0) {
    console.error(`dev: ${left.length} process(es) would not die:`)
    for (const p of left) console.error(`  ${p.pid}  ${short(p.command)}`)
    process.exitCode = 1
    return
  }
  if (!quiet) console.log(killed === 0 ? 'dev: nothing of this repo was running' : 'dev: stopped')
}

function report() {
  const table = processTable()
  const holders = portHolders()
  const own = ownDevProcesses(table, holders)
  console.log(own.length === 0 ? 'dev: not running' : `dev: ${own.length} process(es) in this repo`)
  for (const p of own) console.log(`  ${p.pid}  ${short(p.command)}`)
  for (const port of PORTS) {
    const on = holders.filter(h => h.port === port)
    if (on.length === 0) {
      console.log(`  :${port} free`)
      continue
    }
    for (const { pid } of on) {
      const proc = table.find(p => p.pid === pid)
      const mine = own.some(p => p.pid === pid)
      console.log(`  :${port} ${mine ? 'ours' : 'FOREIGN'} ${pid}  ${short(proc?.command ?? '?')}`)
    }
  }
}

async function preflight() {
  await stop({ quiet: true })
  const table = processTable()
  const own = new Set(ownDevProcesses(table, portHolders()).map(p => p.pid))
  const foreign = portHolders().filter(h => !own.has(h.pid))
  if (foreign.length === 0) return
  console.error('dev: cannot start — another process is on a dev port:')
  for (const { port, pid } of foreign) {
    const proc = table.find(p => p.pid === pid)
    console.error(`  :${port} pid ${pid}  ${short(proc?.command ?? '?', 120)}`)
  }
  console.error('Stop it (or `kill <pid>`) and run `pnpm dev` again.')
  process.exit(1)
}

// ---- Run ---------------------------------------------------------------------------------------

const COLOR = {
  api: '\u001b[34m',
  ui: '\u001b[32m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
}
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Built, not a literal: a regex literal with the escape byte in it trips biome's control-char rule.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = line => line.replace(ANSI, '')

/**
 * Startup chatter neither server needs to show twice: wrangler prints the whole bindings table on
 * boot AND again when the remote `AI` connection settles, repeats every request the app's own pino
 * logger already logged, and advertises the Local Explorer. A suppressed line also swallows the
 * blank and indented lines under it, so a multi-line block goes as one. Warnings and errors that
 * are not on this list are never filtered — and `DEV_VERBOSE=1` shows everything.
 */
const NOISE = [
  /^env\.\w+/,
  /^Binding\s+Resource\s+Mode/,
  /^Your Worker has access to the following bindings:/,
  /^Using secrets defined in \.dev\.vars/,
  /^⛅️? ?wrangler /,
  /^─+$/,
  /^⎔ /,
  /Your types might be out of date/,
  /^\[wrangler:info] (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /,
  /^\[wrangler:info] Ready on /,
  /^\s*(VITE v|➜ {2}|Local: {3}|Network: )/,
  /^\/\*! .* daisyUI/,
  /Scheduled Workers are not automatically triggered/,
  /^Wrangler detected this dev session/,
  /^The Local Explorer API is available/,
  /^Useful routes:/,
  /^If the routes above don't cover/,
  /^(GET|POST|curl) .*\/cdn-cgi\/local\/explorer/,
]

const READY_UI = /Local:\s+(http:\/\/\S*?)\/?\s*$/
const READY_API = /Ready on (http:\/\/\S+)/

function createSpinner(enabled) {
  let frame = 0
  let label = ''
  let timer
  const paint = () => {
    process.stdout.write(
      `\r\u001b[K${COLOR.dim}${SPINNER[frame % SPINNER.length]} ${label}${COLOR.reset}`
    )
    frame += 1
  }
  return {
    set(next) {
      label = next
      if (!enabled) return
      if (!timer) timer = setInterval(paint, 80)
      paint()
    },
    clear() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (enabled) process.stdout.write('\r\u001b[K')
    },
  }
}

/**
 * The Worker's local Hyperdrive binding, pointed at whichever port `pnpm dev:db:up` chose for
 * THIS checkout (scripts/dev-db.mjs writes it to .dev.vars). The toml's `localConnectionString`
 * is only the single-checkout default; without this a second checkout's Worker would talk to
 * the first checkout's database.
 */
function databaseEnv() {
  const file = path.join(WEB_DIR, '.dev.vars')
  if (!existsSync(file)) return {}
  const url = readDevVars(readFileSync(file, 'utf8')).DATABASE_URL
  return url ? { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: url } : {}
}

async function start({ verbose }) {
  await preflight()
  mkdirSync(path.join(WEB_DIR, 'dist/ui'), { recursive: true })

  const startedAt = Date.now()
  const tty = process.stdout.isTTY === true && !verbose
  const spinner = createSpinner(tty)
  const state = { api: false, ui: false, url: '', done: false }
  const children = new Map()
  let shuttingDown = false

  const phase = () => {
    const waiting = [!state.api && 'API', !state.ui && 'UI'].filter(Boolean).join(' + ')
    spinner.set(`starting ${waiting}…`)
  }
  const write = text => {
    spinner.clear()
    process.stdout.write(`${text}\n`)
    if (!state.done) phase()
  }
  /** Per-server: did we drop the previous line? Then its indented continuation goes too. */
  const dropping = { api: false, ui: false }
  const emit = (name, line) => {
    const raw = stripAnsi(line)
    const clean = raw.trim()
    if (!verbose) {
      if (clean === '') return // blank lines never carry information here, and end no block
      if (NOISE.some(r => r.test(clean))) {
        dropping[name] = true
        return
      }
      if (dropping[name] && /^\s/.test(raw)) return
      dropping[name] = false
    }
    write(`${COLOR[name]}[${name}]${COLOR.reset} ${line}`)
  }

  const ready = () => {
    if (state.done || !state.api || !state.ui) return
    state.done = true
    spinner.clear()
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
    process.stdout.write(
      `${COLOR.ui}✔${COLOR.reset} dev ready in ${secs}s  ${COLOR.ui}${state.url || 'http://localhost:3000'}${COLOR.reset}\n` +
        `${COLOR.dim}  api http://localhost:3001 · stop with pnpm dev:stop${COLOR.reset}\n`
    )
  }

  /** Spawn one server, forwarding filtered output; restart it if it dies while we are running. */
  const launch = (name, bin, args) => {
    const child = spawn(path.join(WEB_DIR, 'node_modules/.bin', bin), args, {
      cwd: WEB_DIR,
      env: { ...process.env, FORCE_COLOR: '1', ...databaseEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.set(name, child)
    // Everything a server said before it was ready, kept so a crash can explain itself.
    const buffered = []
    const consume = stream => {
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          const clean = stripAnsi(line).trim()
          if (!state.done) buffered.push(line)
          const uiMatch = name === 'ui' && READY_UI.exec(clean)
          if (uiMatch) {
            state.ui = true
            state.url = uiMatch[1]
            ready()
          } else if (name === 'api' && READY_API.test(clean)) {
            state.api = true
            ready()
          }
          emit(name, line)
        }
      })
    }
    consume(child.stdout)
    consume(child.stderr)

    child.on('exit', code => {
      children.delete(name)
      if (shuttingDown) return
      if (!state.done) {
        // Died during boot: the filter must not hide why.
        spinner.clear()
        process.stderr.write(
          `${COLOR.red}✖ ${name} exited during startup (code ${code})${COLOR.reset}\n`
        )
        for (const line of buffered.slice(-40)) process.stderr.write(`  ${line}\n`)
        void shutdown(1)
        return
      }
      write(`${COLOR.red}✖${COLOR.reset} ${name} exited (code ${code}) — restarting in 2s`)
      setTimeout(() => {
        if (!shuttingDown) launch(name, bin, args)
      }, 2000)
    })
  }

  /**
   * Ctrl-C (SIGINT), `pnpm dev:stop` (SIGTERM) and a child that died during boot all land here:
   * signal the children, then sweep the repo so nothing `wrangler` spawned (workerd, esbuild) is
   * left holding a port. The sweep cannot touch another terminal's `--stop`, and re-entry is
   * ignored so a second Ctrl-C does not race the first.
   */
  const shutdown = async code => {
    if (shuttingDown) return
    shuttingDown = true
    spinner.clear()
    for (const child of children.values()) child.kill('SIGTERM')
    await sleep(500)
    await stop({ quiet: true })
    process.stdout.write(`${COLOR.dim}dev stopped${COLOR.reset}\n`)
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  phase()
  launch('api', 'wrangler', ['dev', '--port', '3001'])
  launch('ui', 'vite', [])
}

const args = process.argv.slice(2)
const mode = args.find(a => a.startsWith('--')) ?? '--status'
const verbose = args.includes('--verbose') || process.env.DEV_VERBOSE === '1'
if (mode === '--start' || mode === '--verbose') await start({ verbose })
else if (mode === '--stop') await stop()
else if (mode === '--preflight') await preflight()
else if (mode === '--status') report()
else {
  console.error(
    `dev-server: unknown mode ${mode} (expected --start | --preflight | --stop | --status)`
  )
  process.exit(2)
}
