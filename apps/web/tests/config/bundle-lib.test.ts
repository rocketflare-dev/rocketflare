/**
 * `scripts/lib/bundle-lib.mjs` — build once, deploy twice (docs/DEPLOYER.md → Build once): the
 * bundle the staging job packs, the checks the production job runs before deploying its bytes, and
 * the two workflow decisions (where production's build comes from; what staging does with the
 * tag's release). The `config` project: no database, no network.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  assetName,
  attachPlan,
  BUNDLE_PROTOCOL,
  bundleDigest,
  collectEntries,
  type Entries,
  makeManifest,
  packBundle,
  productionSource,
  type Release,
  readTomlBasics,
  sha256,
  splitEntries,
  tar,
  unpackBundle,
  untar,
  verifyBundle,
} from '../../../../scripts/lib/bundle-lib.mjs'

const TOML = [
  'name = "app-staging"',
  'main = "src/worker.ts"',
  'compatibility_date = "2026-06-01"',
  'compatibility_flags = ["nodejs_compat"]',
  '',
  '[assets]',
  'directory = "./dist/ui"',
  '',
  '[vars]',
  'main = "not-this-one"',
  '',
].join('\n')

const CHECKOUT = { tag: '1.2.3', commit: 'c'.repeat(40), treeSha: 't'.repeat(40) }

const worker = (): Entries => ({
  'worker.js': Buffer.from('export default {}'),
  'worker.js.map': Buffer.from('{"sourceRoot":"/home/runner"}'),
  'README.md': Buffer.from('built at 12:00'),
  'chunks/lib.js': Buffer.from('export const x = 1'),
  'abc-module.wasm': Buffer.from([0, 97, 115, 109]),
})
const ui = (): Entries => ({
  'index.html': Buffer.from('<html></html>'),
  'assets/app-1a2b.js': Buffer.from('console.log(1)'),
  '.assetsignore': Buffer.from(''),
})

function bundle() {
  const entries = collectEntries({ worker: worker(), ui: ui() })
  const manifest = makeManifest({
    ...CHECKOUT,
    version: '1.2.3',
    toml: TOML,
    wranglerVersion: '4.0.0',
    entries,
  })
  return { manifest, entries }
}

describe('collectEntries / makeManifest', () => {
  it('keeps every module but the source maps and README, and the whole UI', () => {
    expect(Object.keys(bundle().entries).sort()).toEqual([
      'ui/.assetsignore',
      'ui/assets/app-1a2b.js',
      'ui/index.html',
      'worker/abc-module.wasm',
      'worker/chunks/lib.js',
      'worker/worker.js',
    ])
  })

  it('records the build, its toml basics and a sha256 per file', () => {
    const { manifest, entries } = bundle()
    expect(manifest).toMatchObject({
      protocol: BUNDLE_PROTOCOL,
      tag: '1.2.3',
      version: '1.2.3',
      commit: CHECKOUT.commit,
      treeSha: CHECKOUT.treeSha,
      main: 'worker.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      wranglerVersion: '4.0.0',
    })
    expect(manifest.files['worker/worker.js']).toBe(sha256(entries['worker/worker.js']))
    expect(manifest.bundleSha256).toBe(bundleDigest(manifest.files))
  })

  it('reads main and the compatibility settings from the top level only', () => {
    expect(readTomlBasics(TOML)).toEqual({
      main: 'src/worker.ts',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
    })
  })

  it('refuses a build without the entry module', () => {
    const entries = collectEntries({ worker: { 'other.js': Buffer.from('x') }, ui: ui() })
    expect(() => makeManifest({ ...CHECKOUT, version: '1.2.3', toml: TOML, entries })).toThrow(
      /entry module worker\.js/
    )
  })
})

describe('bundleDigest', () => {
  it('is sha256sum output over the sorted files, independent of insertion order', () => {
    const files = { 'worker/b.js': 'b'.repeat(64), 'ui/a.html': 'a'.repeat(64) }
    const reversed = { 'ui/a.html': 'a'.repeat(64), 'worker/b.js': 'b'.repeat(64) }
    expect(bundleDigest(files)).toBe(bundleDigest(reversed))
    expect(bundleDigest(files)).toBe(
      sha256(`${'a'.repeat(64)}  ui/a.html\n${'b'.repeat(64)}  worker/b.js\n`)
    )
  })

  it('matches `sha256sum | sha256sum` over an unpacked bundle', () => {
    let hasSha256sum = true
    try {
      execFileSync('sha256sum', ['--version'], { stdio: 'ignore' })
    } catch {
      hasSha256sum = false
    }
    if (!hasSha256sum) return
    const { manifest, entries } = bundle()
    const dir = mkdtempSync(path.join(tmpdir(), 'bundle-digest-'))
    try {
      for (const [p, bytes] of Object.entries(entries)) {
        mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
        writeFileSync(path.join(dir, p), bytes)
      }
      const out = execFileSync(
        'sh',
        ['-c', 'LC_ALL=C find worker ui -type f | LC_ALL=C sort | xargs sha256sum | sha256sum'],
        { cwd: dir, encoding: 'utf8' }
      )
      expect(out.split(' ')[0]).toBe(manifest.bundleSha256)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('packBundle / unpackBundle', () => {
  it('round-trips the manifest and every byte', () => {
    const original = bundle()
    const back = unpackBundle(packBundle(original))
    expect(back.manifest).toEqual(original.manifest)
    expect(Object.keys(back.entries).sort()).toEqual(Object.keys(original.entries).sort())
    for (const [p, bytes] of Object.entries(original.entries)) {
      expect(back.entries[p].equals(bytes), p).toBe(true)
    }
    expect(verifyBundle(back, { ...CHECKOUT, toml: TOML })).toEqual([])
  })

  it('is deterministic: the same inputs give the same archive bytes', () => {
    const a = bundle()
    const reordered = Object.fromEntries(Object.entries(a.entries).reverse())
    expect(packBundle(a).equals(packBundle({ manifest: a.manifest, entries: reordered }))).toBe(
      true
    )
    // Fixed metadata: mtime 0, mode 0644, owner 0, whatever the files on disk said.
    const header = tar({ 'x.txt': Buffer.from('x') }).subarray(0, 512)
    expect(header.subarray(136, 147).toString()).toBe('00000000000')
    expect(header.subarray(100, 107).toString()).toBe('0000644')
  })

  it('splits back into the wrangler outdir and the assets directory', () => {
    const { worker: w, ui: u } = splitEntries(bundle().entries)
    expect(Object.keys(w).sort()).toEqual(['abc-module.wasm', 'chunks/lib.js', 'worker.js'])
    expect(Object.keys(u).sort()).toEqual(['.assetsignore', 'assets/app-1a2b.js', 'index.html'])
  })

  it('stores a path longer than 100 bytes through the ustar prefix', () => {
    const long = `ui/${'d'.repeat(80)}/${'f'.repeat(60)}.js`
    expect(Object.keys(untar(tar({ [long]: Buffer.from('1') })))).toEqual([long])
  })

  it('refuses an archive entry that escapes the bundle', () => {
    const evil = tar({ 'ok/x': Buffer.from('1') })
    evil.write('../etc/x\0', 0, 'utf8')
    // Recompute the checksum so only the path is wrong.
    evil.write('        ', 148, 'ascii')
    let sum = 0
    for (const b of evil.subarray(0, 512)) sum += b
    evil.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    expect(() => untar(evil)).toThrow(/unsafe path/)
  })

  it('refuses a corrupt header', () => {
    const bad = tar({ 'ok/x': Buffer.from('1') })
    bad.write('ok/y', 0, 'utf8')
    expect(() => untar(bad)).toThrow(/checksum/)
  })

  it('refuses a bundle with no manifest', () => {
    expect(() => unpackBundle(gzipSync(tar({ 'worker/worker.js': Buffer.from('x') })))).toThrow(
      /no manifest/
    )
  })
})

describe('verifyBundle', () => {
  const roundTrip = () => unpackBundle(packBundle(bundle()))

  it('fails a tampered file', () => {
    const b = roundTrip()
    b.entries['worker/worker.js'] = Buffer.from('export default { evil: true }')
    expect(verifyBundle(b, CHECKOUT)).toEqual(['sha256 mismatch: worker/worker.js'])
  })

  it('fails a tampered file whose manifest entry was rewritten to match', () => {
    const b = roundTrip()
    b.entries['worker/worker.js'] = Buffer.from('evil')
    b.manifest.files['worker/worker.js'] = sha256(b.entries['worker/worker.js'])
    expect(verifyBundle(b, CHECKOUT)).toEqual(['bundleSha256 does not match the manifest files'])
  })

  it('fails a file added to, or missing from, the archive', () => {
    const extra = roundTrip()
    extra.entries['worker/extra.js'] = Buffer.from('x')
    expect(verifyBundle(extra, CHECKOUT)).toEqual(['not in the manifest: worker/extra.js'])
    const missing = roundTrip()
    delete missing.entries['ui/index.html']
    expect(verifyBundle(missing, CHECKOUT)).toEqual(['missing from the archive: ui/index.html'])
  })

  it('fails a bundle built from another tree, commit or tag', () => {
    const b = roundTrip()
    expect(verifyBundle(b, { ...CHECKOUT, treeSha: 'f'.repeat(40) })).toEqual([
      `manifest treeSha is ${CHECKOUT.treeSha}, the checkout's is ${'f'.repeat(40)}`,
    ])
    expect(verifyBundle(b, { ...CHECKOUT, commit: 'e'.repeat(40) })[0]).toMatch(/commit/)
    expect(verifyBundle(b, { ...CHECKOUT, tag: '1.2.4' })[0]).toMatch(/tag is 1\.2\.3/)
  })

  it('fails a toml whose main or compatibility settings differ from the build', () => {
    const b = roundTrip()
    const newer = TOML.replace('2026-06-01', '2026-07-01')
    expect(verifyBundle(b, { ...CHECKOUT, toml: newer })).toEqual([
      'compatibility_date 2026-06-01 in the bundle, 2026-07-01 in the toml',
    ])
    const flags = TOML.replace('["nodejs_compat"]', '["nodejs_compat", "x"]')
    expect(verifyBundle(b, { ...CHECKOUT, toml: flags })[0]).toMatch(/compatibility_flags/)
  })

  it('fails another protocol', () => {
    const b = roundTrip()
    b.manifest.protocol = 2
    expect(verifyBundle(b, CHECKOUT)).toEqual(['bundle protocol 2, expected 1'])
  })
})

const release = (over: Partial<Release> = {}): Release => ({
  id: 1,
  tag_name: '1.2.3',
  draft: false,
  created_at: '2026-10-01T00:00:00Z',
  assets: [],
  ...over,
})
const theAsset = { id: 9, name: assetName('1.2.3'), size: 100 }

describe('productionSource', () => {
  it('builds on the plain wrangler path, a branch dispatch, or a tag with no published release', () => {
    expect(productionSource({ deployer: false, tag: '1.2.3', release: release() }).source).toBe(
      'build'
    )
    expect(productionSource({ deployer: true, tag: '', release: null }).source).toBe('build')
    expect(productionSource({ deployer: true, tag: '1.2.3', release: null })).toEqual({
      source: 'build',
      reason: 'no published release for 1.2.3',
    })
  })

  it('builds when the release carries no bundle (an older tag)', () => {
    const plan = productionSource({
      deployer: true,
      tag: '1.2.3',
      release: release({ assets: [{ id: 2, name: 'notes.txt' }] }),
    })
    expect(plan).toEqual({
      source: 'build',
      reason: 'release 1.2.3 has no launch-bundle-1.2.3.tgz (an older tag)',
    })
  })

  it('deploys the bundle when the release carries it', () => {
    const plan = productionSource({
      deployer: true,
      tag: '1.2.3',
      release: release({ assets: [theAsset] }),
    })
    expect(plan).toMatchObject({ source: 'bundle', asset: theAsset })
  })
})

describe('attachPlan', () => {
  it('creates a draft when the tag has no release yet', () => {
    expect(attachPlan([release({ tag_name: '1.2.2' })], '1.2.3')).toEqual({
      action: 'create-draft',
    })
  })

  it('uploads to an existing release without the asset, a published one first', () => {
    const draft = release({ id: 2, draft: true })
    const published = release({ id: 3 })
    expect(attachPlan([draft, published], '1.2.3')).toEqual({
      action: 'upload',
      release: published,
    })
    expect(attachPlan([draft], '1.2.3')).toEqual({ action: 'upload', release: draft })
  })

  it('replaces the asset on a draft (a re-run of staging), never on a published release', () => {
    const draft = release({ id: 2, draft: true, assets: [theAsset] })
    expect(attachPlan([draft], '1.2.3')).toMatchObject({ action: 'replace', release: draft })
    const published = release({ id: 3, assets: [theAsset] })
    expect(attachPlan([draft, published], '1.2.3')).toMatchObject({
      action: 'keep',
      release: published,
    })
  })

  it('among drafts, prefers the one carrying the asset, then the newest', () => {
    const older = release({ id: 4, draft: true, created_at: '2026-01-01T00:00:00Z' })
    const newer = release({ id: 5, draft: true, created_at: '2026-02-01T00:00:00Z' })
    expect(attachPlan([older, newer], '1.2.3')).toMatchObject({ release: { id: 5 } })
    const carrying = { ...older, assets: [theAsset] }
    expect(attachPlan([carrying, newer], '1.2.3')).toMatchObject({
      action: 'replace',
      release: { id: 4 },
    })
  })
})
