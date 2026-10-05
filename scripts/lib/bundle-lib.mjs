/**
 * The pure half of build-once deploys (`scripts/bundle.mjs`, `docs/DEPLOYER.md` → Build once):
 * the staging job packs the bytes it built and validated into `launch-bundle-<tag>.tgz`, and the
 * production job unpacks and deploys THOSE bytes instead of rebuilding the tag.
 *
 * Everything here is deterministic — entries sorted, fixed mtimes, owners and modes — and does no
 * I/O beyond what the caller hands it, so every decision is a unit test
 * (`apps/web/tests/config/bundle-lib.test.ts`). Node built-ins only: it runs before `pnpm install`.
 *
 * Archive layout (a ustar tarball, gzipped):
 *
 *   manifest.json   { protocol, tag, version, commit, treeSha, main, compatibility_date,
 *                     compatibility_flags, wranglerVersion, files: { path: sha256 }, bundleSha256 }
 *   worker/<rel>    every module `wrangler deploy --dry-run --outdir` wrote, minus `*.map` and
 *                   README.md (the filter `scripts/deployer.mjs` uploads with)
 *   ui/<rel>        every file of the toml's `[assets] directory` (dist/ui)
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const BUNDLE_PROTOCOL = 1

/** The release asset's file name for a tag. */
export const assetName = tag => `launch-bundle-${tag}.tgz`

/** The deployer's upload filter: wrangler's source maps and README never ship. */
export const isWorkerModule = rel => !rel.endsWith('.map') && rel !== 'README.md'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Byte order, so the digest is the one `LC_ALL=C sort` gives (see `bundleDigest`). */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/**
 * One digest for the whole bundle: sha256 over `<sha256>  <path>\n` for every file, sorted by
 * path in byte order — `sha256sum` output, so it can be recomputed with coreutils from an unpacked
 * bundle: `LC_ALL=C find worker ui -type f | LC_ALL=C sort | xargs sha256sum | sha256sum`.
 */
export function bundleDigest(files) {
  const lines = Object.keys(files)
    .sort(byteOrder)
    .map(p => `${files[p]}  ${p}\n`)
    .join('')
  return sha256(lines)
}

/** `main`, `compatibility_date` and `compatibility_flags` from a wrangler toml's top level. */
export function readTomlBasics(text) {
  const top = text.split(/^[ \t]*\[/m)[0]
  const str = key => top.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1]
  const flagsRaw = top.match(/^\s*compatibility_flags\s*=\s*\[([^\]]*)\]/m)?.[1]
  const flags = flagsRaw ? [...flagsRaw.matchAll(/["']([^"']+)["']/g)].map(m => m[1]) : []
  return {
    main: str('main'),
    compatibility_date: str('compatibility_date'),
    compatibility_flags: flags,
  }
}

/** The entry module wrangler writes for `main` — what `scripts/deployer.mjs` sends as `main`. */
export const entryModule = main =>
  `${main
    .split('/')
    .pop()
    .replace(/\.[cm]?[jt]sx?$/, '')}.js`

/** A path inside the bundle: relative, posix, no `.`/`..`/empty segments. */
export function safePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) {
    return false
  }
  return p.split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

/**
 * The bundle's file map from the two build outputs: `worker` and `ui` are `{ rel: Buffer }` maps of
 * the wrangler outdir and the assets directory. Returns `{ path: Buffer }`, prefixed and filtered.
 */
export function collectEntries({ worker, ui }) {
  const entries = {}
  for (const [rel, bytes] of Object.entries(worker)) {
    if (isWorkerModule(rel)) entries[`worker/${rel}`] = bytes
  }
  for (const [rel, bytes] of Object.entries(ui ?? {})) entries[`ui/${rel}`] = bytes
  for (const p of Object.keys(entries)) {
    if (!safePath(p)) throw new Error(`refusing to bundle an unsafe path: ${p}`)
  }
  return entries
}

/** The manifest for `entries` (`{ path: Buffer }`, from `collectEntries`). */
export function makeManifest({ tag, version, commit, treeSha, toml, wranglerVersion, entries }) {
  const basics = readTomlBasics(toml)
  if (!basics.main) throw new Error('the wrangler toml has no `main`')
  const main = entryModule(basics.main)
  if (!(`worker/${main}` in entries)) {
    throw new Error(`entry module ${main} (from main = "${basics.main}") is not in the build`)
  }
  const files = {}
  for (const p of Object.keys(entries).sort(byteOrder)) files[p] = sha256(entries[p])
  return {
    protocol: BUNDLE_PROTOCOL,
    tag,
    version,
    commit,
    treeSha,
    main,
    compatibility_date: basics.compatibility_date ?? null,
    compatibility_flags: basics.compatibility_flags,
    wranglerVersion: wranglerVersion ?? null,
    files,
    bundleSha256: bundleDigest(files),
  }
}

// ---- tar (ustar, regular files only) ----------------------------------------------------------

const BLOCK = 512

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function splitName(p) {
  const bytes = Buffer.byteLength(p)
  if (bytes <= 100) return { name: p, prefix: '' }
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i)
    const name = p.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`path too long for a ustar archive: ${p}`)
}

function header(p, size) {
  const h = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(p)
  h.write(name, 0, 100, 'utf8')
  h.write(octal(0o644, 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(size, 12), 124, 'ascii')
  h.write(octal(0, 12), 136, 'ascii') // mtime: fixed, so the archive is reproducible
  h.write('        ', 148, 'ascii') // checksum placeholder
  h.write('0', 156, 'ascii')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return h
}

/** A ustar archive of `{ path: Buffer }`, sorted, fixed metadata. */
export function tar(entries) {
  const parts = []
  for (const p of Object.keys(entries).sort(byteOrder)) {
    const data = Buffer.from(entries[p])
    parts.push(header(p, data.length), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

const field = (h, start, len) => {
  const raw = h.subarray(start, start + len)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? len : end).toString('utf8')
}

/** `{ path: Buffer }` from a ustar archive; anything but a safe regular file is refused. */
export function untar(buf) {
  const entries = {}
  let offset = 0
  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK)
    if (h.every(b => b === 0)) break
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
    const stored = Number.parseInt(field(h, 148, 8).trim(), 8)
    if (stored !== sum) throw new Error(`corrupt archive: bad header checksum at ${offset}`)
    const type = String.fromCharCode(h[156])
    const prefix = field(h, 345, 155)
    const name = field(h, 0, 100)
    const p = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(field(h, 124, 12).trim() || '0', 8)
    if (type !== '0' && type !== '\0')
      throw new Error(`unexpected archive entry type "${type}": ${p}`)
    if (!safePath(p)) throw new Error(`unsafe path in archive: ${p}`)
    if (p in entries) throw new Error(`duplicate path in archive: ${p}`)
    const start = offset + BLOCK
    if (start + size > buf.length) throw new Error(`corrupt archive: ${p} is truncated`)
    entries[p] = Buffer.from(buf.subarray(start, start + size))
    offset = start + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}

// ---- the bundle -------------------------------------------------------------------------------

/** The `.tgz`: `manifest.json` plus every entry. Same inputs, same bytes. */
export function packBundle({ manifest, entries }) {
  if ('manifest.json' in entries) throw new Error('an entry may not be named manifest.json')
  const all = { ...entries, 'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }
  return gzipSync(tar(all), { level: 9 })
}

/** `{ manifest, entries }` from a `.tgz`; throws on a corrupt or unsafe archive. */
export function unpackBundle(tgz) {
  const all = untar(gunzipSync(tgz))
  const raw = all['manifest.json']
  if (!raw) throw new Error('the bundle has no manifest.json')
  let manifest
  try {
    manifest = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('the bundle manifest is not JSON')
  }
  delete all['manifest.json']
  return { manifest, entries: all }
}

/**
 * Everything wrong with a bundle, or `[]`. `expect` is what the deploying job knows for itself —
 * `tag`, and the checked-out `commit` and `treeSha` — plus, optionally, `toml` (the config about to
 * be deployed) whose `main` and compatibility settings must match the build's.
 */
export function verifyBundle({ manifest, entries }, expect) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') return ['the bundle has no manifest']
  if (manifest.protocol !== BUNDLE_PROTOCOL) {
    problems.push(`bundle protocol ${manifest.protocol}, expected ${BUNDLE_PROTOCOL}`)
  }
  for (const key of ['tag', 'commit', 'treeSha']) {
    if (expect[key] !== undefined && manifest[key] !== expect[key]) {
      problems.push(`manifest ${key} is ${manifest[key]}, the checkout's is ${expect[key]}`)
    }
  }
  const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
  if (Object.keys(files).length === 0) problems.push('the manifest lists no files')
  for (const [p, digest] of Object.entries(files)) {
    if (!safePath(p) || !(p.startsWith('worker/') || p.startsWith('ui/'))) {
      problems.push(`the manifest lists an unexpected path: ${p}`)
    } else if (!(p in entries)) problems.push(`missing from the archive: ${p}`)
    else if (sha256(entries[p]) !== digest) problems.push(`sha256 mismatch: ${p}`)
  }
  for (const p of Object.keys(entries)) {
    if (!(p in files)) problems.push(`not in the manifest: ${p}`)
  }
  if (manifest.bundleSha256 !== bundleDigest(files)) {
    problems.push('bundleSha256 does not match the manifest files')
  }
  if (typeof manifest.main !== 'string' || !(`worker/${manifest.main}` in files)) {
    problems.push(`the entry module worker/${manifest.main} is not in the bundle`)
  }
  if (expect.toml !== undefined) {
    const basics = readTomlBasics(expect.toml)
    if (basics.main && entryModule(basics.main) !== manifest.main) {
      problems.push(
        `the toml's main builds ${entryModule(basics.main)}, the bundle's is ${manifest.main}`
      )
    }
    if ((basics.compatibility_date ?? null) !== manifest.compatibility_date) {
      problems.push(
        `compatibility_date ${manifest.compatibility_date} in the bundle, ${basics.compatibility_date} in the toml`
      )
    }
    const a = JSON.stringify([...basics.compatibility_flags].sort())
    const b = JSON.stringify([...(manifest.compatibility_flags ?? [])].sort())
    if (a !== b) problems.push(`compatibility_flags ${b} in the bundle, ${a} in the toml`)
  }
  return problems
}

/** Split verified entries back into the two build outputs: `{ worker: {rel: Buffer}, ui: {…} }`. */
export function splitEntries(entries) {
  const worker = {}
  const ui = {}
  for (const [p, bytes] of Object.entries(entries)) {
    if (p.startsWith('worker/')) worker[p.slice('worker/'.length)] = bytes
    else if (p.startsWith('ui/')) ui[p.slice('ui/'.length)] = bytes
  }
  return { worker, ui }
}

// ---- workflow decisions -----------------------------------------------------------------------

/**
 * Where the production job's Worker and UI come from. `build` is today's path (install-and-build
 * from the tag); `bundle` deploys the staging bundle. Only a missing bundle falls back to a build:
 * a bundle that is present but fails `verifyBundle` fails the job instead (`scripts/bundle.mjs`).
 *
 *   deployer  DEPLOYER_URL is set (the plain `wrangler deploy` path always builds)
 *   tag       the tag being deployed, or empty for a dispatch from a branch
 *   release   the published GitHub Release for the tag, or null
 */
export function productionSource({ deployer, tag, release }) {
  if (!deployer) return { source: 'build', reason: 'no DEPLOYER_URL: the wrangler path builds' }
  if (!tag) return { source: 'build', reason: 'not a tag: a dispatch from a branch builds' }
  if (!release) return { source: 'build', reason: `no published release for ${tag}` }
  const asset = (release.assets ?? []).find(a => a.name === assetName(tag))
  if (!asset) {
    return { source: 'build', reason: `release ${tag} has no ${assetName(tag)} (an older tag)` }
  }
  return { source: 'bundle', reason: `release ${tag} carries ${asset.name}`, asset }
}

/**
 * What the staging side does with the bundle, given every release in the repository (drafts
 * included — the token has `contents: write`).
 *
 *   create-draft  no release for the tag yet: create a DRAFT carrying the asset. A draft fires no
 *                 `release: published`, so production does not start until somebody publishes it
 *   upload        a release exists without the asset: add it
 *   replace       a DRAFT already carries one (a re-run of staging): swap in the bytes just validated
 *   keep          a PUBLISHED release already carries one: never swap the bytes under a release
 *                 production may already have shipped
 *
 * A published release for the tag wins over drafts; among drafts, the one already carrying the
 * asset wins, then the newest.
 */
export function attachPlan(releases, tag) {
  const name = assetName(tag)
  const forTag = releases.filter(r => r.tag_name === tag)
  const published = forTag.find(r => !r.draft)
  const withAsset = r => (r.assets ?? []).find(a => a.name === name)
  const release =
    published ??
    forTag.find(r => withAsset(r)) ??
    [...forTag].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!release) return { action: 'create-draft' }
  const asset = withAsset(release)
  if (!asset) return { action: 'upload', release }
  if (release.draft) return { action: 'replace', release, asset }
  return { action: 'keep', release, asset }
}
