#!/usr/bin/env node
/**
 * One-shot first run (`pnpm bootstrap`, or `bash scripts/bootstrap.sh` when Node/pnpm may be
 * missing): nine steps from a fresh clone to a running stack with the browser signed in — the
 * hand-run walkthrough in SETUP.md Part 1, as one idempotent command. Every step is re-runnable on
 * a half-done machine: it inspects before it acts and never overwrites a value a person wrote.
 *
 *   1 toolchain   2 install   3 secrets   4 database   5 migrate   6 seed
 *   7 cloudflare  8 cli       9 run
 *
 * Output follows `apps/web/scripts/dev-server.mjs`: each child's output is buffered and shown only
 * when it fails (`--verbose` / `DEV_VERBOSE=1` streams everything), one `✔ n/9` line per step with
 * its verification, and the dev stack is started through `pnpm dev` so its preflight sweep and
 * ownership rules apply unchanged. Everything shells out to the root pnpm scripts — `migrate.ts`
 * and `seed.ts` need `tsx` and `node_modules`, which may not exist yet.
 *
 * `--check` (`pnpm preflight`) is the read-only half: steps 1, 3, 4 (one `db:check`, no compose
 * up), 7 and `dev-server.mjs --status`, every failure listed, exit 3 if any.
 *
 * Exit codes: 0 ok · 1 a step failed · 2 usage · 3 prerequisite missing · 4 a port or the Postgres
 * container is held by another checkout · 5 Cloudflare login required.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import {
  aiBlockState,
  extractSeedKey,
  fillDevVars,
  parseNvmrc,
  parseWhoami,
  readDevVars,
  toggleAiBlock,
  versionAtLeast,
} from './lib/bootstrap-lib.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WEB_DIR = path.join(REPO_ROOT, 'apps/web')
const DEV_VARS = path.join(WEB_DIR, '.dev.vars')
const DEV_VARS_EXAMPLE = path.join(WEB_DIR, '.dev.vars.example')
const COMPOSE_FILE = path.join(WEB_DIR, 'docker-compose.dev.yml')
const TOMLS = ['wrangler.toml', 'wrangler.staging.toml'].map(f => path.join(WEB_DIR, f))
/** Keys `config.ts` validates with `optionalSecret(32)` — blank is "unset", short is a ConfigError. */
const REQUIRED_SECRETS = ['OAUTH_ENCRYPTION_KEY']
const SECRET_MIN_LENGTH = 32
const API_URL = 'http://localhost:3001'
const UI_URL = 'http://localhost:3000'
const HEALTH_TIMEOUT_MS = 90_000
const DB_CHECK_ATTEMPTS = 30
const TOTAL_STEPS = 9
const TAIL_LINES = 30

const EXIT = { ok: 0, failed: 1, usage: 2, prerequisite: 3, held: 4, login: 5 }

// ---- Arguments ---------------------------------------------------------------------------------

const USAGE = `Usage: pnpm bootstrap [options]        (or: bash scripts/bootstrap.sh [options])

Take a fresh clone to a running, signed-in dev stack in one command. Re-runnable.

  --yes         never prompt; a missing Cloudflare login is exit 5 instead of a question
  --offline     comment the [ai] block out of both wrangler tomls (no Cloudflare account needed;
                chat/agents/embeddings then need a key or a tenant provider)
  --online      keep/restore the [ai] block; exit 5 if wrangler is not logged in
  --no-dev      stop after step 7 and print the commands to run next
  --no-demo     seed without the demo data (plain \`pnpm seed\`)
  --share-db    accept a Postgres container started from another checkout (one shared database)
  --no-open     do not open the browser once the server answers
  --as <email>  seeded account to sign in as (default owner@example.test)
  --check       read-only preflight (= pnpm preflight): toolchain, secrets, database, Cloudflare,
                dev status; exit 3 when anything is missing
  --verbose     stream every child's output (also DEV_VERBOSE=1)
  --help        this text

Exit codes: 0 ok · 1 a step failed · 2 usage · 3 prerequisite missing · 4 port/container held by
another checkout · 5 Cloudflare login required`

function parseArgs(argv) {
  const opts = {
    yes: false,
    shareDb: false,
    offline: false,
    online: false,
    dev: true,
    demo: true,
    open: true,
    as: 'owner@example.test',
    check: false,
    verbose: process.env.DEV_VERBOSE === '1',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--yes':
        opts.yes = true
        break
      case '--offline':
        opts.offline = true
        break
      case '--online':
        opts.online = true
        break
      case '--no-dev':
        opts.dev = false
        break
      case '--no-demo':
        opts.demo = false
        break
      case '--share-db':
        opts.shareDb = true
        break
      case '--no-open':
        opts.open = false
        break
      case '--check':
        opts.check = true
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--as': {
        const value = argv[i + 1]
        if (!value || value.startsWith('--')) throw new UsageError('--as needs an email')
        opts.as = value
        i += 1
        break
      }
      default:
        if (arg.startsWith('--as=')) {
          opts.as = arg.slice('--as='.length)
          break
        }
        throw new UsageError(`unknown option ${arg}`)
    }
  }
  if (opts.offline && opts.online) throw new UsageError('--offline and --online exclude each other')
  return opts
}

class UsageError extends Error {}

/** A step's failure: what to print (the child's tail + a fix hint) and how to exit. */
class StepError extends Error {
  constructor(message, { hint = '', output = '', exitCode = EXIT.failed } = {}) {
    super(message)
    this.hint = hint
    this.output = output
    this.exitCode = exitCode
  }
}

// ---- Output ------------------------------------------------------------------------------------

const tty = process.stdout.isTTY === true
const ESC = String.fromCharCode(27) // built, not a literal: biome rejects the control char
const paint = code => text => (tty ? `${ESC}[${code}m${text}${ESC}[0m` : text)
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const dim = paint('2')
const bold = paint('1')

const say = text => process.stdout.write(`${text}\n`)
const tail = output =>
  output
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-TAIL_LINES)

const stepLabel = (n, name) => `${String(n)}/${TOTAL_STEPS} ${name.padEnd(10)}`

function printOk(n, name, verify, notes = []) {
  say(`${green('✔')} ${stepLabel(n, name)} ${verify}`)
  for (const note of notes) say(`  ${dim(note)}`)
}

function printFail(n, name, err) {
  say(`${red('✖')} ${stepLabel(n, name)} ${err.message}`)
  for (const line of tail(err.output ?? '')) say(`  ${dim(line)}`)
  if (err.hint) say(`  ${bold('fix:')} ${err.hint}`)
}

// ---- Children ----------------------------------------------------------------------------------

let verbose = false

/**
 * Run a child, buffering its combined output; `verbose` streams it as well. Resolves with
 * `{ code, output }` and never rejects — a missing binary is `code: 127` with the error as output.
 */
function run(cmd, args, { cwd = REPO_ROOT, env = process.env, input } = {}) {
  return new Promise(resolve => {
    let output = ''
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: 127, output: String(error) })
      return
    }
    const consume = stream => {
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        output += chunk
        if (verbose) process.stdout.write(chunk)
      })
    }
    consume(child.stdout)
    consume(child.stderr)
    child.on('error', error => resolve({ code: 127, output: `${output}\n${error.message}` }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
    if (input) child.stdin.end(input)
  })
}

/** Run a child on the terminal (login prompts, the dev stack); resolves with its exit code. */
function runInherit(cmd, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' })
    child.on('error', () => resolve(127))
    child.on('close', code => resolve(code ?? 1))
  })
}

const has = bin => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** `pnpm <script> …` at the root — the only way the bootstrap reaches migrate/seed/db:check. */
const pnpm = (args, opts) => run('pnpm', args, opts)

// ---- Steps -------------------------------------------------------------------------------------

async function stepToolchain() {
  const nvmrc = parseNvmrc(readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8'))
  if (!versionAtLeast(process.version, nvmrc)) {
    throw new StepError(`node ${process.version} < ${nvmrc}`, {
      hint: `bash scripts/bootstrap.sh installs Node ${nvmrc} via fnm/nvm, or: nvm install ${nvmrc}`,
      exitCode: EXIT.prerequisite,
    })
  }
  const pnpmVersion = await pnpm(['-v'])
  const pnpmV = pnpmVersion.output.trim().split('\n').pop() ?? ''
  if (pnpmVersion.code !== 0 || !pnpmV.startsWith('10.')) {
    throw new StepError(`pnpm 10.x not found (${pnpmV || 'missing'})`, {
      hint: 'corepack enable   (reads packageManager from package.json)',
      output: pnpmVersion.output,
      exitCode: EXIT.prerequisite,
    })
  }
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (docker.code !== 0) {
    throw new StepError('docker daemon not reachable', {
      hint:
        process.platform === 'darwin'
          ? 'brew install colima docker && colima start   (or start Docker Desktop)'
          : 'install Docker Engine, add your user to the docker group, start the daemon',
      output: docker.output,
      exitCode: EXIT.prerequisite,
    })
  }
  const compose = await run('docker', ['compose', 'version', '--short'])
  if (compose.code !== 0) {
    throw new StepError('docker compose (v2 plugin) not found', {
      hint: 'install the docker-compose-plugin (Docker Desktop and colima ship it)',
      output: compose.output,
      exitCode: EXIT.prerequisite,
    })
  }
  for (const bin of ['lsof', 'ps', 'git']) {
    if (!has(bin)) {
      throw new StepError(`${bin} not on PATH`, {
        hint: `install ${bin} (dev-server.mjs needs lsof/ps to own its ports)`,
        exitCode: EXIT.prerequisite,
      })
    }
  }
  return {
    verify: `node ${process.version} · pnpm ${pnpmV} · docker ${docker.output.trim()} · compose ${compose.output.trim()}`,
  }
}

async function stepInstall() {
  const result = await pnpm(['install', '--prefer-offline'])
  if (result.code !== 0) {
    throw new StepError('pnpm install failed', {
      hint: 'read the tail above; a registry outage is the usual cause — re-run',
      output: result.output,
    })
  }
  const wrangler = path.join(WEB_DIR, 'node_modules/.bin/wrangler')
  if (!existsSync(wrangler)) {
    throw new StepError('apps/web/node_modules/.bin/wrangler missing after install', {
      hint: 'pnpm install --force',
      output: result.output,
    })
  }
  return { verify: 'apps/web/node_modules/.bin/wrangler present' }
}

/** Verify-only when `write` is false (`--check`). */
function stepSecrets({ write }) {
  const example = readFileSync(DEV_VARS_EXAMPLE, 'utf8')
  const existing = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : null
  const notes = []
  let text = existing
  if (write) {
    const result = fillDevVars(
      example,
      existing,
      () => randomBytes(32).toString('hex'),
      REQUIRED_SECRETS
    )
    if (existing === null || result.text !== existing) writeFileSync(DEV_VARS, result.text)
    text = result.text
    if (existing === null) notes.push('created apps/web/.dev.vars from .dev.vars.example')
    if (result.filled.length > 0) notes.push(`generated ${result.filled.join(', ')}`)
    for (const key of result.missing) {
      notes.push(`warning: ${key} is in .dev.vars.example but not in your .dev.vars`)
    }
  } else if (text === null) {
    throw new StepError('apps/web/.dev.vars is missing', {
      hint: 'pnpm bootstrap (creates it from .dev.vars.example and generates the keys)',
      exitCode: EXIT.prerequisite,
    })
  }
  const values = readDevVars(text)
  const short = REQUIRED_SECRETS.filter(key => (values[key] ?? '').length < SECRET_MIN_LENGTH)
  if (short.length > 0) {
    throw new StepError(`${short.join(', ')} must be at least ${SECRET_MIN_LENGTH} characters`, {
      hint: `openssl rand -hex 32 → ${short[0]} in apps/web/.dev.vars`,
      exitCode: EXIT.prerequisite,
    })
  }
  return {
    verify: `${REQUIRED_SECRETS.join(', ')} set (≥ ${SECRET_MIN_LENGTH} chars) in apps/web/.dev.vars`,
    notes,
  }
}

const dbCheck = () => pnpm(['web', 'db:check'])
const dbVerifyLine = output =>
  output
    .split('\n')
    .filter(line => /^Connected to |^pgvector extension/.test(line))
    .join(' · ')

/** `--check`: one `db:check`, no compose. */
async function stepDatabaseCheck() {
  const result = await dbCheck()
  if (result.code !== 0) {
    throw new StepError('Postgres on :5432 not reachable', {
      hint: 'pnpm dev:db:up   (or pnpm bootstrap, which waits for it)',
      output: result.output,
      exitCode: EXIT.prerequisite,
    })
  }
  return { verify: dbVerifyLine(result.output) }
}

async function stepDatabase(opts) {
  const up = await run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], {
    cwd: WEB_DIR,
  })
  if (up.code !== 0) {
    const conflict = /container name "\/?([^"]+)" is already in use/i.exec(up.output)
    if (conflict) {
      const name = conflict[1]
      const inspect = await run('docker', [
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
        name,
      ])
      const other = inspect.output.trim() || 'an unknown directory'
      throw new StepError(`container ${name} belongs to another checkout: ${other}`, {
        hint: `stop it there: pnpm dev:db:down in ${other}  (the compose file pins container_name)`,
        output: up.output,
        exitCode: EXIT.held,
      })
    }
    throw new StepError('docker compose up failed', {
      hint: 'is another Postgres on :5432? `lsof -nP -iTCP:5432 -sTCP:LISTEN`',
      output: up.output,
    })
  }
  // Compose derives the project name from the directory (`web`), so a second checkout does NOT
  // collide on the pinned container_name — it silently attaches to the other checkout's database.
  // Say so, and only continue when asked to.
  const notes = []
  const other = await foreignComposeOwner()
  if (other) {
    const sharing =
      `Postgres container was started from another checkout: ${other}\n` +
      '  both checkouts would share ONE database (same container, same volume).'
    if (opts.shareDb) {
      notes.push(`${sharing}\n  continuing (--share-db)`)
    } else if (!opts.yes && process.stdin.isTTY) {
      say(`  ${sharing}`)
      const answer = (
        await ask('  [c]ontinue sharing it, or [a]bort and stop it there first? [c/a] ')
      )
        .trim()
        .toLowerCase()
      if (answer !== 'c') {
        throw new StepError('database belongs to another checkout', {
          hint: `pnpm dev:db:down in ${other}, then re-run — or pass --share-db`,
          exitCode: EXIT.held,
        })
      }
      notes.push('sharing the database with the other checkout')
    } else {
      throw new StepError('database belongs to another checkout', {
        hint: `pnpm dev:db:down in ${other}, then re-run — or pass --share-db to use one database`,
        exitCode: EXIT.held,
      })
    }
  }
  // `--wait` honours the compose healthcheck, but first boot restarts postgres once after
  // pg_isready first succeeds — the poll is what migrate.ts's waitForDatabase would do.
  let last = { code: 1, output: '' }
  for (let attempt = 1; attempt <= DB_CHECK_ATTEMPTS; attempt += 1) {
    last = await dbCheck()
    if (last.code === 0) break
    await sleep(1000)
  }
  if (last.code !== 0) {
    throw new StepError(`Postgres did not answer within ${DB_CHECK_ATTEMPTS} s`, {
      hint: 'docker compose -f apps/web/docker-compose.dev.yml logs postgres-dev',
      output: last.output,
    })
  }
  return { verify: dbVerifyLine(last.output), notes }
}

/**
 * The checkout that started the dev Postgres container, when it is not this one (compose's
 * `working_dir` label); null when it is ours or cannot be read.
 */
async function foreignComposeOwner() {
  const ps = await run('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '-q'], { cwd: WEB_DIR })
  const id = ps.output.trim().split('\n')[0]
  if (ps.code !== 0 || !id) return null
  const inspect = await run('docker', [
    'inspect',
    '--format',
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
    id,
  ])
  const owner = inspect.output.trim()
  if (inspect.code !== 0 || !owner) return null
  const same = (a, b) => {
    try {
      return realpathSync(a) === realpathSync(b)
    } catch {
      return a === b
    }
  }
  return same(owner, WEB_DIR) ? null : owner
}

async function stepMigrate() {
  const result = await pnpm(['db:migrate'])
  if (result.code !== 0 || !result.output.includes('Migrations applied')) {
    throw new StepError('pnpm db:migrate did not report "Migrations applied"', {
      hint: 'pnpm web db:check, then pnpm db:migrate by hand and read its output',
      output: result.output,
    })
  }
  return { verify: 'Migrations applied (role → migrations → grants)' }
}

/** Returns the one-time API key, kept in memory only, or undefined when the seed had one. */
async function stepSeed({ demo }) {
  const result = await pnpm(demo ? ['seed', '--demo'] : ['seed'])
  if (result.code !== 0) {
    throw new StepError('pnpm seed failed', {
      hint: 'pnpm seed by hand and read the error above',
      output: result.output,
    })
  }
  // The seed's stdout goes through unchanged: the one-time API key print is intentional.
  if (!verbose) process.stdout.write(result.output)
  const key = extractSeedKey(result.output)
  return {
    verify: key
      ? 'demo tenant + users; API key minted (shown once above)'
      : 'demo tenant + users; API key already existed',
    key,
  }
}

const wranglerWhoami = async () =>
  parseWhoami((await pnpm(['web', 'exec', 'wrangler', 'whoami'])).output)

const AI_COST_NOTE =
  'Workers AI is the zero-key floor for chat, agents and embeddings: 10 000 free neurons a day, ' +
  'then metered, billed to that Cloudflare account. `pnpm bootstrap --offline` turns it off.'

function setAiBlocks(mode) {
  for (const file of TOMLS) {
    const text = readFileSync(file, 'utf8')
    const next = toggleAiBlock(text, mode)
    if (next !== text) writeFileSync(file, next)
  }
}

const aiState = () => aiBlockState(readFileSync(TOMLS[0], 'utf8'))

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise(resolve => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

/**
 * Logged in → `[ai]` stays (or comes back with `--online`; `--offline` still turns it off).
 * Not logged in → `--offline` comments the block out of both tomls; `--online` / `--yes` / a
 * non-TTY stdin exit 5 with the login command; a terminal is asked once.
 */
async function stepCloudflare(opts) {
  let who = await wranglerWhoami()
  const notes = []
  const offlineNotes = () => [
    '[ai] commented out in both wrangler tomls — chat, agents and embeddings need an API key or',
    'a tenant provider (SETUP.md §2.5); `pnpm typecheck` regenerates worker-configuration.d.ts',
    'without `AI` — do not commit that diff. `pnpm bootstrap --online` restores the block.',
  ]
  if (who.loggedIn) {
    const identity = [who.email, who.account].filter(Boolean).join(' · ')
    if (opts.offline) {
      setAiBlocks('off')
      return { verify: `logged in as ${identity}; [ai] off (--offline)`, notes: offlineNotes() }
    }
    if (aiState() === 'off' && opts.online) {
      setAiBlocks('on')
      notes.push('[ai] restored in both wrangler tomls (--online)')
    }
    const state = aiState()
    if (state === 'on') notes.push(AI_COST_NOTE)
    else notes.push('[ai] is commented out; `pnpm bootstrap --online` restores it')
    return { verify: `logged in as ${identity}; [ai] ${state}`, notes }
  }

  if (opts.offline) {
    setAiBlocks('off')
    return { verify: 'not logged in; [ai] off (--offline)', notes: offlineNotes() }
  }
  const loginRequired = () =>
    new StepError('wrangler is not logged in', {
      hint: 'pnpm web exec wrangler login   (a free account is enough)  — or: pnpm bootstrap --offline',
      exitCode: EXIT.login,
    })
  if (opts.online || opts.yes || opts.check || !process.stdin.isTTY) throw loginRequired()

  say(
    `${yellow('?')} Cloudflare: \`wrangler dev\` calls Workers AI through the [ai] binding, which needs`
  )
  say('  a logged-in account (free is enough). Offline comments the block out of both tomls.')
  const answer = (await ask('  [l]ogin now (recommended) / [o]ffline: ')).trim().toLowerCase()
  if (answer.startsWith('o')) {
    setAiBlocks('off')
    return { verify: 'not logged in; [ai] off (chosen)', notes: offlineNotes() }
  }
  const code = await runInherit('pnpm', ['web', 'exec', 'wrangler', 'login'])
  who = await wranglerWhoami()
  if (code !== 0 || !who.loggedIn) throw loginRequired()
  const identity = [who.email, who.account].filter(Boolean).join(' · ')
  return { verify: `logged in as ${identity}; [ai] ${aiState()}`, notes: [AI_COST_NOTE] }
}

/** Step 8, run after the server answers: the CLI against the seed key, env of the child only. */
async function stepCli(key) {
  const result = await pnpm(['--silent', 'cli', 'whoami'], {
    env: { ...process.env, ROCKETFLARE_API_KEY: key, ROCKETFLARE_URL: API_URL },
  })
  if (result.code !== 0) {
    throw new StepError(`pnpm cli whoami exited ${result.code}`, {
      hint: 'pnpm cli login --server http://localhost:3001',
      output: result.output,
    })
  }
  return { verify: 'pnpm cli whoami with the seed key', output: result.output }
}

/** Poll `/api/health` until it answers or the budget is spent (a dead child exits the process). */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // ECONNREFUSED while wrangler boots is the normal state; keep polling.
    }
    await sleep(1000)
  }
  return false
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // No opener: the URL is printed anyway.
  }
}

// ---- Orchestration -----------------------------------------------------------------------------

/** Run one numbered step; print its line; a StepError ends the run with its exit code. */
async function step(n, name, fn) {
  try {
    const result = await fn()
    printOk(n, name, result.verify, result.notes)
    return result
  } catch (error) {
    const err = error instanceof StepError ? error : new StepError(String(error?.stack ?? error))
    printFail(n, name, err)
    process.exit(err.exitCode)
  }
}

async function check() {
  const failures = []
  const tryStep = async (n, name, fn) => {
    try {
      const result = await fn()
      printOk(n, name, result.verify, result.notes)
    } catch (error) {
      const err = error instanceof StepError ? error : new StepError(String(error))
      printFail(n, name, err)
      failures.push(name)
    }
  }
  await tryStep(1, 'toolchain', stepToolchain)
  await tryStep(3, 'secrets', () => stepSecrets({ write: false }))
  await tryStep(4, 'database', stepDatabaseCheck)
  await tryStep(7, 'cloudflare', async () => {
    if (!existsSync(path.join(WEB_DIR, 'node_modules/.bin/wrangler'))) {
      throw new StepError('wrangler not installed yet', {
        hint: 'pnpm bootstrap (step 2 installs it), then pnpm preflight again',
        exitCode: EXIT.prerequisite,
      })
    }
    const who = await wranglerWhoami()
    const state = aiState()
    if (!who.loggedIn && state === 'on') {
      throw new StepError('wrangler not logged in while [ai] is on', {
        hint: 'pnpm web exec wrangler login — or pnpm bootstrap --offline',
        exitCode: EXIT.login,
      })
    }
    const identity = who.loggedIn
      ? `logged in as ${[who.email, who.account].filter(Boolean).join(' · ')}`
      : 'not logged in'
    return { verify: `${identity}; [ai] ${state}` }
  })
  const status = await run('node', [path.join(WEB_DIR, 'scripts/dev-server.mjs'), '--status'])
  say(dim('— pnpm dev:status —'))
  process.stdout.write(status.output)
  if (failures.length > 0) {
    say(`${red('✖')} preflight: ${failures.join(', ')} — fix the above and run pnpm bootstrap`)
    process.exit(EXIT.prerequisite)
  }
  say(`${green('✔')} preflight ok — pnpm bootstrap (or pnpm dev) is ready to run`)
}

async function bootstrap(opts) {
  say(bold(`Rocketflare bootstrap — ${REPO_ROOT}`))
  await step(1, 'toolchain', stepToolchain)
  await step(2, 'install', stepInstall)
  await step(3, 'secrets', () => stepSecrets({ write: true }))
  await step(4, 'database', () => stepDatabase(opts))
  await step(5, 'migrate', stepMigrate)
  const seeded = await step(6, 'seed', () => stepSeed({ demo: opts.demo }))
  await step(7, 'cloudflare', () => stepCloudflare(opts))

  const loginUrl = `${UI_URL}/login?as=${encodeURIComponent(opts.as)}`
  if (!opts.dev) {
    const why = seeded.key ? '--no-dev' : 'no new seed key'
    printOk(8, 'cli', `skipped (${why}) — after \`pnpm dev\`: pnpm cli login --server ${API_URL}`)
    printOk(9, 'run', 'skipped (--no-dev). Next:')
    say('  pnpm dev')
    say(`  ${loginUrl}`)
    say(`  pnpm cli login --server ${API_URL}`)
    return
  }
  if (seeded.key) say(`${dim('·')} ${stepLabel(8, 'cli')} deferred until the server answers`)
  else printOk(8, 'cli', 'skipped — key already exists; run `pnpm cli login` once the server is up')

  // dev-server's preflight, piped, so a foreign port holder is a clear exit 4 rather than a
  // child dying on the terminal; `pnpm dev` runs the same sweep again (idempotent) in a moment.
  const preflight = await run('node', [path.join(WEB_DIR, 'scripts/dev-server.mjs'), '--preflight'])
  if (preflight.code !== 0) {
    printFail(
      9,
      'run',
      new StepError('a dev port is held by another checkout or app', {
        hint: 'stop it (pnpm dev:stop there, or kill <pid>) and re-run',
        output: preflight.output,
        exitCode: EXIT.held,
      })
    )
    process.exit(EXIT.held)
  }

  say(`${dim('·')} ${stepLabel(9, 'run')} starting pnpm dev (Ctrl-C stops everything)`)
  const startedAt = Date.now()
  const child = spawn('pnpm', ['dev'], { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' })
  const forward = signal => () => {
    child.kill(signal)
  }
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
  // The stack's exit code is ours — except after a health timeout, where dev-server's clean
  // shutdown (exit 0) must not turn a failed step 9 into a success.
  let runFailed = false
  child.on('close', code => process.exit(runFailed ? EXIT.failed : (code ?? 0)))

  if (!(await waitForHealth())) {
    runFailed = true
    printFail(
      9,
      'run',
      new StepError(`${API_URL}/api/health did not answer within ${HEALTH_TIMEOUT_MS / 1000} s`, {
        hint: 'read the [api] lines above; pnpm dev:status shows what is running',
      })
    )
    child.kill('SIGTERM')
    return
  }
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
  printOk(9, 'run', `${API_URL}/api/health ok in ${secs}s`)

  if (seeded.key) {
    try {
      const cli = await stepCli(seeded.key)
      printOk(8, 'cli', cli.verify)
      for (const line of cli.output.trimEnd().split('\n')) say(`  ${line}`)
    } catch (error) {
      const err = error instanceof StepError ? error : new StepError(String(error))
      printFail(8, 'cli', err) // the server is up; a CLI hiccup does not stop the stack
    }
  }

  say(`${green('✔')} ready  ${bold(loginUrl)}`)
  if (opts.open) openBrowser(loginUrl)
  else say(dim('  (--no-open: open the URL above)'))
}

// ---- Main --------------------------------------------------------------------------------------

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`bootstrap: ${error.message}\n\n${USAGE}\n`)
  process.exit(EXIT.usage)
}
if (opts.help) {
  say(USAGE)
  process.exit(EXIT.ok)
}
verbose = opts.verbose
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.stderr.write('bootstrap: macOS or Linux only (Windows: WSL2)\n')
  process.exit(EXIT.prerequisite)
}
if (typeof os.userInfo === 'function' && os.userInfo().uid === 0) {
  process.stderr.write('bootstrap: refusing to run as root — run as your own user\n')
  process.exit(EXIT.prerequisite)
}
if (opts.check) await check()
else await bootstrap(opts)
