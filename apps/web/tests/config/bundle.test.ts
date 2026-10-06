/**
 * `scripts/bundle.mjs` — the staging job packs its build and attaches it to a DRAFT release; the
 * production job deploys that bundle instead of rebuilding (docs/DEPLOYER.md → Build once).
 *
 * Runs the real script as a child process in a throwaway git repository (the bundle is bound to
 * the checkout's commit and tree) against a `node:http` fake of the GitHub releases API. The pure
 * decisions are unit-tested in `bundle-lib.test.ts`; this is the I/O around them.
 */
import { execFile, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/bundle.mjs')
const REPO = 'acme/app'
const TAG = '1.2.3'
const ASSET = `launch-bundle-${TAG}.tgz`

interface FakeAsset {
  id: number
  name: string
  size: number
  bytes: Buffer
}
interface FakeRelease {
  id: number
  tag_name: string
  draft: boolean
  created_at: string
  assets: FakeAsset[]
}

let server: Server
let base = ''
let releases: FakeRelease[] = []
let calls: string[] = []
let nextId = 100

const publicRelease = (r: FakeRelease) => ({
  id: r.id,
  tag_name: r.tag_name,
  draft: r.draft,
  created_at: r.created_at,
  upload_url: `${base}/uploads/repos/${REPO}/releases/${r.id}/assets{?name,label}`,
  assets: r.assets.map(({ id, name, size }) => ({ id, name, size })),
})

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const url = new URL(req.url ?? '/', base)
  calls.push(`${req.method} ${url.pathname}`)
  if (req.headers.authorization !== 'Bearer gh-token') return reply(res, 401, {})
  const api = `/repos/${REPO}/releases`

  if (req.method === 'GET' && url.pathname.startsWith(`${api}/tags/`)) {
    const tag = decodeURIComponent(url.pathname.slice(`${api}/tags/`.length))
    const found = releases.find(r => r.tag_name === tag && !r.draft)
    return found ? reply(res, 200, publicRelease(found)) : reply(res, 404, { message: 'Not Found' })
  }
  if (req.method === 'GET' && url.pathname === api) {
    const page = Number(url.searchParams.get('page') ?? 1)
    return reply(res, 200, page === 1 ? releases.map(publicRelease) : [])
  }
  if (req.method === 'POST' && url.pathname === api) {
    const input = JSON.parse(body.toString('utf8'))
    const created: FakeRelease = {
      id: nextId++,
      tag_name: input.tag_name,
      draft: input.draft,
      created_at: new Date().toISOString(),
      assets: [],
    }
    releases.push(created)
    return reply(res, 201, publicRelease(created))
  }
  const releaseRoute = url.pathname.match(/^\/repos\/acme\/app\/releases\/(\d+)$/)
  if (req.method === 'DELETE' && releaseRoute) {
    const id = Number(releaseRoute[1])
    if (!releases.some(r => r.id === id)) return reply(res, 404, {})
    releases = releases.filter(r => r.id !== id)
    res.writeHead(204)
    return res.end()
  }
  const upload = url.pathname.match(/^\/uploads\/repos\/acme\/app\/releases\/(\d+)\/assets$/)
  if (req.method === 'POST' && upload) {
    const r = releases.find(x => x.id === Number(upload[1]))
    const name = url.searchParams.get('name') ?? ''
    if (!r) return reply(res, 404, {})
    if (r.assets.some(a => a.name === name)) return reply(res, 422, { message: 'already_exists' })
    const asset = { id: nextId++, name, size: body.length, bytes: body }
    r.assets.push(asset)
    return reply(res, 201, { id: asset.id, name, size: asset.size })
  }
  const assetRoute = url.pathname.match(/^\/repos\/acme\/app\/releases\/assets\/(\d+)$/)
  if (assetRoute) {
    const id = Number(assetRoute[1])
    const owner = releases.find(r => r.assets.some(a => a.id === id))
    const asset = owner?.assets.find(a => a.id === id)
    if (!owner || !asset) return reply(res, 404, {})
    if (req.method === 'DELETE') {
      owner.assets = owner.assets.filter(a => a.id !== id)
      res.writeHead(204)
      return res.end()
    }
    // GitHub redirects an octet-stream download to storage.
    res.writeHead(302, { location: `${base}/storage/${id}` })
    return res.end()
  }
  const storage = url.pathname.match(/^\/storage\/(\d+)$/)
  if (storage) {
    const asset = releases.flatMap(r => r.assets).find(a => a.id === Number(storage[1]))
    if (!asset) return reply(res, 404, {})
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(asset.bytes)
  }
  return reply(res, 404, { message: 'no such route' })
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
let outputFile = ''

const toml = (name: string) =>
  [
    `name = "${name}"`,
    'main = "src/worker.ts"',
    'compatibility_date = "2026-06-01"',
    'compatibility_flags = ["nodejs_compat"]',
    '',
    '[assets]',
    'directory = "./dist/ui"',
    '',
  ].join('\n')

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })

function writeBuild() {
  const w = path.join(dir, 'web/dist/deploy')
  const u = path.join(dir, 'web/dist/ui')
  mkdirSync(path.join(w, 'chunks'), { recursive: true })
  mkdirSync(path.join(u, 'assets'), { recursive: true })
  writeFileSync(path.join(w, 'worker.js'), 'export default {}')
  writeFileSync(path.join(w, 'worker.js.map'), '{}')
  writeFileSync(path.join(w, 'README.md'), 'wrangler output')
  writeFileSync(path.join(w, 'chunks/lib.js'), 'export const x = 1')
  writeFileSync(path.join(w, 'mod.wasm'), Buffer.from([0, 97, 115, 109]))
  writeFileSync(path.join(u, 'index.html'), '<html></html>')
  writeFileSync(path.join(u, 'assets/app.js'), 'console.log(1)')
}

/** `{ rel: contents }` of a directory, for comparing build outputs. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[path.relative(root, full)] = readFileSync(full).toString('base64')
    }
  }
  walk(root)
  return out
}

beforeEach(() => {
  releases = []
  calls = []
  dir = mkdtempSync(path.join(tmpdir(), 'bundle-'))
  outputFile = path.join(dir, 'github-output')
  writeFileSync(outputFile, '')
  mkdirSync(path.join(dir, 'web'), { recursive: true })
  writeFileSync(path.join(dir, 'web/wrangler.staging.toml'), toml('app-staging'))
  writeFileSync(path.join(dir, 'web/wrangler.toml'), toml('app'))
  writeFileSync(path.join(dir, '.gitignore'), 'dist/\ngithub-output\n*.tgz\n')
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'release')
  writeBuild()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function outputs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=')
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

const bundleFile = () => path.join(dir, ASSET)

function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GITHUB_API_URL: base,
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: 'gh-token',
    GITHUB_OUTPUT: outputFile,
    DEPLOYER_URL: 'https://deployer.example.test',
    TOML: 'web/wrangler.staging.toml',
    DEPLOYER_OUTDIR: 'web/dist/deploy',
    BUNDLE_TAG: TAG,
    RELEASE_VERSION: TAG,
    BUNDLE_FILE: bundleFile(),
    BUNDLE_RETRY_MS: '1',
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const options = { env: env as unknown as NodeJS.ProcessEnv, cwd: dir }
    execFile(process.execPath, [SCRIPT, ...args], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const PROD = { TOML: 'web/wrangler.toml' }

/** The staging side: pack, then attach. */
async function stage() {
  const pack = await run(['pack'])
  expect(pack.code, pack.stderr).toBe(0)
  const attach = await run(['attach', bundleFile()])
  expect(attach.code, attach.stderr).toBe(0)
  return attach
}

/** Somebody (Launch, or a person in GitHub) publishes the draft. */
function publish() {
  for (const r of releases) if (r.tag_name === TAG) r.draft = false
}

describe('scripts/bundle.mjs', () => {
  it('pack writes the bundle and its digest to $GITHUB_OUTPUT', async () => {
    const pack = await run(['pack'])
    expect(pack.code, pack.stderr).toBe(0)
    expect(outputs()).toMatchObject({
      file: bundleFile(),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const verify = await run(['verify', bundleFile()], PROD)
    expect(verify.code, verify.stderr).toBe(0)
  })

  it('attach creates a DRAFT release for the tag carrying the bundle', async () => {
    await stage()
    expect(releases).toHaveLength(1)
    expect(releases[0]).toMatchObject({ tag_name: TAG, draft: true })
    expect(releases[0].assets.map(a => a.name)).toEqual([ASSET])
    expect(releases[0].assets[0].bytes.equals(readFileSync(bundleFile()))).toBe(true)
  })

  it('a re-run of staging replaces the asset on the draft rather than failing with 422', async () => {
    await stage()
    const first = releases[0].assets[0].id
    await stage()
    expect(releases).toHaveLength(1)
    expect(releases[0].assets.map(a => a.name)).toEqual([ASSET])
    expect(releases[0].assets[0].id).not.toBe(first)
    expect(calls).toContain(`DELETE /repos/${REPO}/releases/assets/${first}`)
  })

  it('never swaps the bytes under a published release that already carries a bundle', async () => {
    await stage()
    publish()
    const before = releases[0].assets[0].id
    const again = await stage()
    expect(again.stdout).toMatch(/left as they are/)
    expect(releases[0].assets[0].id).toBe(before)
  })

  it('attach adds the bundle to a release that was published before staging finished', async () => {
    releases.push({ id: 7, tag_name: TAG, draft: false, created_at: '2026-01-01', assets: [] })
    await stage()
    expect(releases).toHaveLength(1)
    expect(releases[0].assets.map(a => a.name)).toEqual([ASSET])
  })

  it('prune deletes unpromoted bundle drafts beyond the newest N, and nothing else', async () => {
    const draft = (id: number, tag: string, assets = [`launch-bundle-${tag}.tgz`]) => ({
      id,
      tag_name: tag,
      draft: true,
      created_at: '2026-01-01',
      assets: assets.map((name, i) => ({
        id: id * 10 + i,
        name,
        size: 1,
        bytes: Buffer.from('x'),
      })),
    })
    releases.push(
      draft(1, '1.0.0'),
      draft(2, '1.1.0'),
      draft(3, '1.2.0'),
      draft(4, '1.2.1'),
      draft(5, '1.2.2', ['launch-bundle-1.2.2.tgz', 'notes.pdf']), // somebody's: two assets
      { id: 6, tag_name: '0.9.0', draft: false, created_at: '2026-01-01', assets: [] }, // published
      draft(7, '2.0.0') // newer than the tag deployed: another deploy's
    )
    await stage()
    const pruned = await run(['prune'], { BUNDLE_KEEP_DRAFTS: '2' })
    expect(pruned.code, pruned.stderr).toBe(0)
    // Kept: 1.2.3 (just attached) and 1.2.1. Deleted: 1.2.0, 1.1.0, 1.0.0.
    expect(releases.map(r => r.tag_name).sort()).toEqual(['0.9.0', '1.2.1', '1.2.2', TAG, '2.0.0'])
    expect(calls).toContain(`DELETE /repos/${REPO}/releases/3`)
    expect(pruned.stdout).toMatch(/kept 2 bundle draft\(s\), deleted 3/)

    const off = await run(['prune'], { BUNDLE_KEEP_DRAFTS: '0' })
    expect(off.code, off.stderr).toBe(0)
    expect(off.stdout).toContain('pruning is off')
    expect(releases).toHaveLength(5)

    const bad = await run(['prune'], { BUNDLE_KEEP_DRAFTS: 'some' })
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('BUNDLE_KEEP_DRAFTS must be a whole number')
  })

  it('fetch deploys the staging bytes: the same outdir and UI the staging upload read', async () => {
    await stage()
    publish()
    const built = {
      worker: tree(path.join(dir, 'web/dist/deploy')),
      ui: tree(path.join(dir, 'web/dist/ui')),
    }
    rmSync(path.join(dir, 'web/dist'), { recursive: true, force: true })

    const fetched = await run(['fetch'], PROD)
    expect(fetched.code, fetched.stderr).toBe(0)
    expect(outputs().source).toBe('bundle')
    const { 'worker.js.map': _map, 'README.md': _readme, ...modules } = built.worker
    expect(tree(path.join(dir, 'web/dist/deploy'))).toEqual(modules)
    expect(tree(path.join(dir, 'web/dist/ui'))).toEqual(built.ui)
  })

  it('fetch replaces whatever was in the build directories', async () => {
    await stage()
    publish()
    writeFileSync(path.join(dir, 'web/dist/deploy/stale.js'), 'old')
    const fetched = await run(['fetch'], PROD)
    expect(fetched.code, fetched.stderr).toBe(0)
    expect(Object.keys(tree(path.join(dir, 'web/dist/deploy')))).not.toContain('stale.js')
  })

  it('fetch falls back to a build when the tag has no published release, or no bundle', async () => {
    const none = await run(['fetch'], PROD)
    expect(none.code, none.stderr).toBe(0)
    expect(outputs().source).toBe('build')
    expect(none.stdout).toMatch(/no published release for 1\.2\.3/)

    releases.push({ id: 8, tag_name: TAG, draft: false, created_at: '2026-01-01', assets: [] })
    writeFileSync(outputFile, '')
    const old = await run(['fetch'], PROD)
    expect(old.code, old.stderr).toBe(0)
    expect(outputs().source).toBe('build')
    expect(old.stdout).toMatch(/an older tag/)
  })

  it('fetch ignores a bundle still on a draft: drafts are not the promotion', async () => {
    await stage()
    const fetched = await run(['fetch'], PROD)
    expect(fetched.code, fetched.stderr).toBe(0)
    expect(outputs().source).toBe('build')
  })

  it('fetch builds without asking GitHub on a branch dispatch or with no deployer', async () => {
    const branch = await run(['fetch'], { ...PROD, BUNDLE_TAG: '' })
    expect(branch.code, branch.stderr).toBe(0)
    expect(outputs().source).toBe('build')
    writeFileSync(outputFile, '')
    const plain = await run(['fetch'], { ...PROD, DEPLOYER_URL: undefined })
    expect(plain.code, plain.stderr).toBe(0)
    expect(outputs().source).toBe('build')
    expect(calls).toEqual([])
  })

  it('fetch FAILS on a tampered bundle instead of deploying or rebuilding it', async () => {
    await stage()
    publish()
    const asset = releases[0].assets[0]
    const { gunzipSync, gzipSync } = await import('node:zlib')
    const raw = gunzipSync(asset.bytes)
    const at = raw.indexOf('export default {}')
    raw.write('export default []', at)
    asset.bytes = gzipSync(raw)
    const fetched = await run(['fetch'], PROD)
    expect(fetched.code).toBe(1)
    expect(fetched.stderr).toMatch(/sha256 mismatch: worker\/worker\.js/)
    expect(outputs().source).toBeUndefined()
  })

  it('fetch FAILS on a bundle built from another tree (a tag moved after staging)', async () => {
    await stage()
    publish()
    writeFileSync(path.join(dir, 'web/extra.txt'), 'later')
    git('add', '.')
    git('commit', '-q', '-m', 'moved')
    const fetched = await run(['fetch'], PROD)
    expect(fetched.code).toBe(1)
    expect(fetched.stderr).toMatch(/manifest treeSha is [0-9a-f]{40}, the checkout's is/)
    expect(fetched.stderr).toMatch(/manifest commit is/)
  })
})
