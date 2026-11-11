#!/usr/bin/env node
/**
 * The sandbox a security audit runs target code in (`.claude/skills/rf-security`).
 *
 *   pnpm security:sandbox build [--ref <git-ref>]        image from a `git archive` of the ref (HEAD)
 *   pnpm security:sandbox verify                         prove the isolation holds; exit 1 if not
 *   pnpm security:sandbox test --run <dir> [--name <id>] [--isolated] [files…]
 *                                                        vitest over <dir>/poc against a fresh DB
 *   pnpm security:sandbox down                           stop the sandbox's own containers
 *
 * It never deletes a directory it did not create in this process, and never reads or forwards the
 * caller's environment beyond what the docker CLI needs to find its daemon.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const COMPOSE_FILE = path.join(ROOT, 'apps/web/docker-compose.security.yml')
const DOCKERFILE = path.join(ROOT, 'apps/web/docker/Dockerfile.security-sandbox')
const IMAGE = 'rocketflare-security-sandbox'
const RUNS_ROOT = path.join(os.homedir(), '.rocketflare', 'security-runs')
const PROJECT = 'rocketflare-security'

/** The docker CLI needs these to find the daemon; nothing else crosses to it. */
function dockerEnv(extra = {}) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  return result.status ?? 1
}

function compose(args, extraEnv = {}, project = PROJECT) {
  return run('docker', ['compose', '-f', COMPOSE_FILE, '-p', project, ...args], {
    env: dockerEnv(extraEnv),
  })
}

function flag(args, name) {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const value = args[at + 1]
  if (!value) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}

/** A run directory lives under ~/.rocketflare/security-runs, so nothing else can be mounted. */
function resolveRunDir(dir) {
  if (!dir) throw new Error('--run <dir> is required')
  const resolved = fs.realpathSync(path.resolve(dir))
  const root = fs.realpathSync(RUNS_ROOT)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing ${resolved}: a run directory must be inside ${root}`)
  }
  return resolved
}

function build(args) {
  const ref = flag(args, '--ref') ?? 'HEAD'
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const pnpmVersion = String(pkg.packageManager).replace('pnpm@', '').split('+')[0]
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-context-'))
  try {
    const archive = path.join(context, '.source.tar')
    const archived = run('git', ['archive', '--format=tar', '-o', archive, ref], { cwd: ROOT })
    if (archived !== 0) return archived
    const unpacked = run('tar', ['-xf', archive, '-C', context])
    if (unpacked !== 0) return unpacked
    fs.rmSync(archive)
    const commit = spawnSync('git', ['rev-parse', ref], { cwd: ROOT, encoding: 'utf8' })
    return run(
      'docker',
      [
        'build',
        '-t',
        IMAGE,
        '--label',
        `rocketflare.security.source=${commit.stdout.trim()}`,
        '-f',
        DOCKERFILE,
        '--build-arg',
        `PNPM_VERSION=${pnpmVersion}`,
        context,
      ],
      { env: dockerEnv() }
    )
  } finally {
    fs.rmSync(context, { recursive: true, force: true })
  }
}

function runner(scratch, poc, command, project = PROJECT) {
  return compose(
    ['--profile', 'run', 'run', '--rm', '--no-TTY', 'runner', ...command],
    { SECURITY_SCRATCH: scratch, SECURITY_POC: poc },
    project
  )
}

function stop(project, scratch, poc) {
  return compose(
    ['--profile', 'run', 'down', '--volumes', '--remove-orphans'],
    { SECURITY_SCRATCH: scratch, SECURITY_POC: poc },
    project
  )
}

function prepareRun(dir) {
  const runDir = resolveRunDir(dir)
  const scratch = path.join(runDir, 'scratch')
  const poc = path.join(runDir, 'poc')
  for (const d of [scratch, poc]) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(scratch, 'home'), { recursive: true })
  return { scratch, poc }
}

/** Runs inside the container; every probe must come back as the isolated answer. */
const PROBE = `
const fs = require('node:fs'), net = require('node:net'), dns = require('node:dns').promises
const connect = (host, port) => new Promise(res => {
  const s = net.connect({ host, port, timeout: 3000 })
  s.on('connect', () => { s.destroy(); res(true) })
  s.on('timeout', () => { s.destroy(); res(false) })
  s.on('error', () => res(false))
})
const writable = p => { try { fs.writeFileSync(p, 'x'); fs.rmSync(p); return true } catch { return false } }
const ALLOWED = new Set(['HOME','TMPDIR','CI','NPM_CONFIG_OFFLINE','XDG_CACHE_HOME','XDG_CONFIG_HOME',
  'XDG_DATA_HOME','XDG_STATE_HOME','PATH','HOSTNAME','NODE_VERSION','YARN_VERSION','PWD','SHLVL','_'])
;(async () => {
  const checks = {
    'external IP unreachable': !(await connect('1.1.1.1', 443)),
    'DNS for a public name fails': await dns.lookup('example.com').then(() => false, () => true),
    'Postgres reachable on localhost:5433': await connect('127.0.0.1', 5433),
    'source is read-only': !writable('/src/package.json.probe'),
    'root filesystem is read-only': !writable('/etc/probe'),
    'scratch is writable': writable('/scratch/.probe'),
    'HOME is the scratch home': process.env.HOME === '/scratch/home',
    'no docker socket': !fs.existsSync('/var/run/docker.sock'),
    'no .dev.vars in the image': !fs.existsSync('/src/apps/web/.dev.vars'),
    'not root': process.getuid() !== 0,
    'environment is the allowlist': Object.keys(process.env).every(k => ALLOWED.has(k)),
  }
  let failed = false
  for (const [name, ok] of Object.entries(checks)) {
    console.log((ok ? 'ok    ' : 'FAIL  ') + name)
    failed ||= !ok
  }
  process.exit(failed ? 1 : 0)
})()
`

function verify() {
  fs.mkdirSync(RUNS_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(RUNS_ROOT, 'verify-'))
  try {
    const { scratch, poc } = prepareRun(dir)
    return runner(scratch, poc, ['node', '-e', PROBE])
  } finally {
    stop(PROJECT, dir, dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function test(args) {
  const { scratch, poc } = prepareRun(flag(args, '--run'))
  // `--name` gives parallel callers their own containers and database.
  const name = flag(args, '--name')
  if (name && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error(`bad --name: ${name}`)
  const project = name ? `${PROJECT}-${name}` : PROJECT
  // Proofs starting `// @vitest-isolate` belong to the api-isolated project (module mocks).
  const isolatedAt = args.indexOf('--isolated')
  if (isolatedAt !== -1) args.splice(isolatedAt, 1)
  const vitestProject = isolatedAt !== -1 ? ['api-isolated'] : ['api', '--no-isolate']
  const files = args.length > 0 ? args : ['tests/api/_poc']
  try {
    return runner(
      scratch,
      poc,
      ['pnpm', 'exec', 'dotenv', '-e', '.env.test', '--', 'vitest', 'run', '--project'].concat(
        vitestProject,
        files
      ),
      project
    )
  } finally {
    stop(project, scratch, poc)
  }
}

function down() {
  return stop(PROJECT, os.tmpdir(), os.tmpdir())
}

const [command, ...rest] = process.argv.slice(2)
const commands = { build, verify, test, down }
if (!commands[command]) {
  console.error('usage: pnpm security:sandbox build|verify|test|down')
  process.exit(2)
}
process.exit(commands[command](rest))
