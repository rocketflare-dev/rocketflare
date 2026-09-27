/**
 * `scripts/deployer.mjs` — the deploy job's side of the external-deployer protocol
 * (docs/DEPLOYER.md, v1).
 *
 * Runs the real script as a child process against a `node:http` fake that plays both the deployer
 * and GitHub's OIDC token endpoint, over a fixture wrangler outdir, toml and assets directory in a
 * temp dir. The child runs asynchronously: a `spawnSync` would block the event loop the fake server
 * answers on.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/deployer.mjs')
const REQUEST_TOKEN = 'actions-request-token'
const MIGRATOR_URL = 'postgresql://migrator:s3cr%2Ft@db.example.test:5432/app?sslmode=require'

interface Seen {
  method: string
  url: string
  authorization?: string
  body?: unknown
}

/** What the fake deployer answers; each test sets the parts it needs. */
interface Script {
  startStatus: string
  /** Statuses the GET poll returns in turn; the last one repeats. */
  polls: string[]
  uploadStatus: number
  uploadBody: Record<string, unknown>
  finishStatus: number
}

let server: Server
let base = ''
let seen: Seen[] = []
let script: Script
let polls = 0

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url ?? '/', base)
  const entry: Seen = {
    method: req.method ?? '',
    url: `${url.pathname}${url.search}`,
    authorization: req.headers.authorization,
    body: raw ? JSON.parse(raw) : undefined,
  }
  seen.push(entry)

  // GitHub's OIDC token endpoint: the token encodes the audience asked for, so the deployer side
  // can check the script asked for the right one.
  if (url.pathname === '/oidc') {
    if (req.headers.authorization !== `bearer ${REQUEST_TOKEN}`) return reply(res, 401, {})
    return reply(res, 200, { value: `jwt-for:${url.searchParams.get('audience')}` })
  }
  if (req.method === 'POST' && url.pathname === '/deployer/deploy/start') {
    return reply(res, 200, { id: 'tkt-1', status: script.startStatus })
  }
  if (req.method === 'GET' && url.pathname === '/deployer/deploy/tkt-1') {
    const status = script.polls[Math.min(polls, script.polls.length - 1)]
    polls++
    return reply(res, 200, { id: 'tkt-1', status })
  }
  if (req.method === 'POST' && url.pathname === '/deployer/deploy/tkt-1/upload') {
    return reply(res, script.uploadStatus, script.uploadBody)
  }
  if (req.method === 'POST' && url.pathname === '/deployer/deploy/tkt-1/activate') {
    return reply(res, 200, { id: 'tkt-1', status: 'active' })
  }
  if (req.method === 'POST' && url.pathname === '/deployer/deploy/tkt-1/finish') {
    return reply(res, script.finishStatus, { id: 'tkt-1', status: 'finished' })
  }
  return reply(res, 404, { error: 'no such route' })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch(error => reply(res, 500, { error: String(error) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

let dir = ''
let githubEnv = ''

beforeEach(() => {
  seen = []
  polls = 0
  script = {
    startStatus: 'approved',
    polls: ['approved'],
    uploadStatus: 200,
    uploadBody: { id: 'tkt-1', status: 'uploaded', versionId: 'v-1', migratorUrl: MIGRATOR_URL },
    finishStatus: 200,
  }
  dir = mkdtempSync(path.join(tmpdir(), 'deployer-'))
  githubEnv = path.join(dir, 'github-env')
  writeFileSync(githubEnv, '')
  // A wrangler package: toml, the dry-run outdir and the built UI.
  mkdirSync(path.join(dir, 'web/dist/deploy/chunks'), { recursive: true })
  mkdirSync(path.join(dir, 'web/dist/ui/assets'), { recursive: true })
  writeFileSync(
    path.join(dir, 'web/wrangler.staging.toml'),
    [
      'name = "app-staging"',
      'main = "src/worker.ts"',
      '',
      '[vars]',
      'directory = "not-this-one"',
      '',
      '[assets]',
      'directory = "./dist/ui"',
      'binding = "ASSETS"',
      '',
      '[[kv_namespaces]]',
      'binding = "RATE_LIMIT_KV"',
      '',
    ].join('\n')
  )
  writeFileSync(path.join(dir, 'web/dist/deploy/worker.js'), 'export default {}')
  writeFileSync(path.join(dir, 'web/dist/deploy/worker.js.map'), '{}')
  writeFileSync(path.join(dir, 'web/dist/deploy/README.md'), 'wrangler output')
  writeFileSync(path.join(dir, 'web/dist/deploy/chunks/lib.js'), 'export const x = 1')
  writeFileSync(
    path.join(dir, 'web/dist/deploy/abc123-module.wasm'),
    Buffer.from([0, 97, 115, 109])
  )
  writeFileSync(path.join(dir, 'web/dist/deploy/data.bin'), Buffer.from([1, 2, 3]))
  writeFileSync(path.join(dir, 'web/dist/ui/index.html'), '<html></html>')
  writeFileSync(path.join(dir, 'web/dist/ui/assets/app.js'), 'console.log(1)')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** `NAME=value` lines the script appended to $GITHUB_ENV. */
function exported(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(githubEnv, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=')
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

function run(command: string, extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DEPLOYER_URL: `${base}/deployer`,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    GITHUB_ENV: githubEnv,
    TOML: path.join(dir, 'web/wrangler.staging.toml'),
    RELEASE_VERSION: '1.2.3',
    WAIT_SECONDS: '5',
    DEPLOYER_POLL_SECONDS: '0.05',
    ...exported(),
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    // A bare env, not process.env: nothing of the test runner's may leak into the script.
    const options = { env: env as unknown as NodeJS.ProcessEnv, cwd: dir }
    execFile(process.execPath, [SCRIPT, command], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const deployerCalls = () => seen.filter(s => s.url.startsWith('/deployer/'))
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')

describe('scripts/deployer.mjs', () => {
  it('runs start → upload → activate → finish with a fresh bearer token per call', async () => {
    script.startStatus = 'pending'
    script.polls = ['pending', 'approved']

    const start = await run('start')
    expect(start.code, start.stderr).toBe(0)
    expect(exported().DEPLOYER_TICKET).toBe('tkt-1')

    const upload = await run('upload')
    expect(upload.code, upload.stderr).toBe(0)
    const activate = await run('activate')
    expect(activate.code, activate.stderr).toBe(0)
    const finish = await run('finish')
    expect(finish.code, finish.stderr).toBe(0)

    expect(deployerCalls().map(s => `${s.method} ${s.url}`)).toEqual([
      'POST /deployer/deploy/start',
      'GET /deployer/deploy/tkt-1',
      'GET /deployer/deploy/tkt-1',
      'POST /deployer/deploy/tkt-1/upload',
      'POST /deployer/deploy/tkt-1/activate',
      'POST /deployer/deploy/tkt-1/finish',
    ])
    // Audience defaults to the deployer's origin; the token goes out as a Bearer on every call,
    // and a new one is minted for each (one OIDC request per deployer call).
    for (const call of deployerCalls()) {
      expect(call.authorization).toBe(`Bearer jwt-for:${base}`)
    }
    expect(seen.filter(s => s.url.startsWith('/oidc'))).toHaveLength(deployerCalls().length)
    expect(seen.find(s => s.url.startsWith('/oidc'))?.url).toContain('api-version=2.0')
    expect(deployerCalls()[0].body).toEqual({ protocol: 1 })
  })

  it('uploads every module but source maps, the toml, the assets, version and protocol', async () => {
    await run('start')
    const upload = await run('upload')
    expect(upload.code, upload.stderr).toBe(0)

    const body = deployerCalls().find(s => s.url.endsWith('/upload'))?.body as {
      protocol: number
      version: string
      main: string
      toml: string
      modules: Record<string, string>
      assets: Record<string, string>
    }
    expect(body.protocol).toBe(1)
    expect(body.version).toBe('1.2.3')
    expect(body.main).toBe('worker.js')
    expect(body.toml).toBe(readFileSync(path.join(dir, 'web/wrangler.staging.toml'), 'utf8'))
    expect(Object.keys(body.modules).sort()).toEqual([
      'abc123-module.wasm',
      'chunks/lib.js',
      'data.bin',
      'worker.js',
    ])
    expect(body.modules['abc123-module.wasm']).toBe(b64(Buffer.from([0, 97, 115, 109])))
    expect(body.modules['worker.js']).toBe(b64('export default {}'))
    expect(body.assets).toEqual({
      '/assets/app.js': b64('console.log(1)'),
      '/index.html': b64('<html></html>'),
    })
  })

  it('masks the migrator credentials and exports MIGRATOR_URL without printing it', async () => {
    await run('start')
    const upload = await run('upload')
    expect(upload.code, upload.stderr).toBe(0)
    expect(exported().MIGRATOR_URL).toBe(MIGRATOR_URL)
    expect(upload.stdout).toContain(`::add-mask::${MIGRATOR_URL}`)
    expect(upload.stdout).toContain('::add-mask::s3cr%2Ft')
    expect(upload.stdout).toContain('::add-mask::s3cr/t')
    // The only lines carrying the secret are the mask commands themselves.
    const leaks = upload.stdout
      .split('\n')
      .filter(line => line.includes('s3cr') && !line.startsWith('::add-mask::'))
    expect(leaks).toEqual([])
    expect(upload.stdout).toContain('"versionId":"v-1"')
  })

  it('honours DEPLOYER_AUDIENCE', async () => {
    const start = await run('start', { DEPLOYER_AUDIENCE: 'my-deployer' })
    expect(start.code, start.stderr).toBe(0)
    expect(deployerCalls()[0].authorization).toBe('Bearer jwt-for:my-deployer')
  })

  it('fails when the ticket is rejected', async () => {
    script.startStatus = 'pending'
    script.polls = ['pending', 'rejected']
    const start = await run('start')
    expect(start.code).not.toBe(0)
    expect(start.stderr).toMatch(/rejected/)
  })

  it('fails when approval does not arrive in time', async () => {
    script.startStatus = 'pending'
    script.polls = ['pending']
    const start = await run('start', { WAIT_SECONDS: '0.3' })
    expect(start.code).not.toBe(0)
    expect(start.stderr).toMatch(/not approved within 0.3s/)
  })

  it('fails the upload on a non-200 and exports nothing', async () => {
    await run('start')
    script.uploadStatus = 403
    script.uploadBody = { error: 'bindings not registered for this app', migratorUrl: MIGRATOR_URL }
    const upload = await run('upload')
    expect(upload.code).toBe(1)
    expect(upload.stderr).toMatch(/403 bindings not registered/)
    expect(`${upload.stdout}${upload.stderr}`).not.toContain('s3cr')
    expect(exported().MIGRATOR_URL).toBeUndefined()
  })

  it('refuses to upload without the build output', async () => {
    await run('start')
    rmSync(path.join(dir, 'web/dist/ui'), { recursive: true })
    const upload = await run('upload')
    expect(upload.code).toBe(1)
    expect(upload.stderr).toMatch(/\[assets\] directory not found/)
    expect(deployerCalls().some(s => s.url.endsWith('/upload'))).toBe(false)
  })

  it('finish without a ticket is a no-op', async () => {
    const finish = await run('finish')
    expect(finish.code, finish.stderr).toBe(0)
    expect(seen).toEqual([])
  })

  it('says what is missing when the job has no id-token permission', async () => {
    const start = await run('start', {
      ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
    })
    expect(start.code).toBe(1)
    expect(start.stderr).toMatch(/id-token: write/)
    expect(seen).toEqual([])
  })
})
