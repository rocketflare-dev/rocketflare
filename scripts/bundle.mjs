#!/usr/bin/env node
// Build once, deploy twice (docs/DEPLOYER.md → Build once; the deployer path of deploy.yml only).
//
// The staging job packs the Worker and UI it built — and then uploaded, migrated and activated —
// into `launch-bundle-<tag>.tgz`; a separate job attaches it to a DRAFT GitHub Release for the tag.
// Publishing that draft is the promotion (`release: published`), and the production job deploys
// the bundle's bytes instead of rebuilding the tag. The pure half is `scripts/lib/bundle-lib.mjs`.
//
//   node scripts/bundle.mjs pack           build outputs → BUNDLE_FILE      → $GITHUB_OUTPUT file, digest
//   node scripts/bundle.mjs verify FILE    FILE against the checkout (tag, commit, tree, toml)
//   node scripts/bundle.mjs attach FILE    FILE onto the tag's release (a new DRAFT when none exists)
//   node scripts/bundle.mjs fetch          production: the release's bundle → DEPLOYER_OUTDIR + dist/ui
//                                          → $GITHUB_OUTPUT source=bundle|build
//
// Environment:
//   TOML               the wrangler config of this job (its `[assets] directory` is the UI dir)
//   DEPLOYER_OUTDIR    the `wrangler deploy --dry-run --outdir` directory; default dist/deploy by TOML
//   BUNDLE_TAG         the tag deployed; empty for a dispatch from a branch (fetch → build)
//   RELEASE_VERSION    recorded in the manifest (pack)
//   BUNDLE_FILE        the .tgz written by pack; default dist/launch-bundle-<tag>.tgz by TOML
//   DEPLOYER_URL       fetch builds when unset (the plain wrangler path never runs this script)
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL (default https://api.github.com)
//   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY — set by GitHub Actions
//
// Node only, no dependencies, like scripts/deployer.mjs.
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readToml } from './deployer.mjs'
import {
  assetName,
  attachPlan,
  collectEntries,
  makeManifest,
  packBundle,
  productionSource,
  splitEntries,
  unpackBundle,
  verifyBundle,
} from './lib/bundle-lib.mjs'

/** The largest asset `fetch` downloads; a real bundle is ~1 MB. */
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024

const env = name => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

class BundleError extends Error {}
const fail = message => {
  throw new BundleError(message)
}

function output(name, value) {
  const file = env('GITHUB_OUTPUT')
  if (file) appendFileSync(file, `${name}=${value}\n`)
}

function summary(text) {
  const file = env('GITHUB_STEP_SUMMARY')
  if (file) appendFileSync(file, `${text}\n`)
}

const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** What this checkout is: the commit and tree the bundle must have been built from. */
const checkout = () => ({
  commit: git(['rev-parse', 'HEAD']),
  treeSha: git(['rev-parse', 'HEAD^{tree}']),
})

function paths() {
  const tomlPath = env('TOML') ?? fail('TOML is not set (e.g. apps/web/wrangler.staging.toml)')
  if (!existsSync(tomlPath)) fail(`TOML not found: ${tomlPath}`)
  const toml = readFileSync(tomlPath, 'utf8')
  const webDir = path.dirname(tomlPath)
  const outdir = env('DEPLOYER_OUTDIR') ?? path.join(webDir, 'dist/deploy')
  const { assetsDirectory } = readToml(toml)
  const uiDir = assetsDirectory ? path.resolve(webDir, assetsDirectory) : undefined
  return { tomlPath, toml, webDir, outdir, uiDir }
}

/** `{ rel: Buffer }` for every file under `dir`. */
function readTree(dir) {
  const out = {}
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[path.relative(dir, full).split(path.sep).join('/')] = readFileSync(full)
    }
  }
  walk(dir)
  return out
}

function writeTree(dir, files) {
  rmSync(dir, { recursive: true, force: true })
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, bytes)
  }
}

function wranglerVersion(webDir) {
  try {
    return JSON.parse(readFileSync(path.join(webDir, 'node_modules/wrangler/package.json'), 'utf8'))
      .version
  } catch {
    return null
  }
}

function requireTag() {
  return env('BUNDLE_TAG') ?? fail('BUNDLE_TAG is not set')
}

function verifyAgainstCheckout(bundle, { tag, toml }) {
  const problems = verifyBundle(bundle, { tag, ...checkout(), toml })
  if (problems.length) {
    fail(`the bundle does not match this checkout:\n  - ${problems.join('\n  - ')}`)
  }
}

// ---- GitHub ------------------------------------------------------------------------------------

function api() {
  return (env('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/+$/, '')
}

function repo() {
  return env('GITHUB_REPOSITORY') ?? fail('GITHUB_REPOSITORY is not set')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One GitHub call, retried on a network error or a 5xx. Returns the Response. */
async function github(method, url, { body, accept, contentType } = {}) {
  const token = env('GITHUB_TOKEN') ?? fail('GITHUB_TOKEN is not set')
  const target = url.startsWith('http') ? url : `${api()}${url}`
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(target, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: accept ?? 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        body,
      })
      if (res.status < 500) return res
      last = `${res.status} ${(await res.text()).slice(0, 200)}`
    } catch (error) {
      last = error.message
    }
    if (attempt < 3) await sleep(Number(env('BUNDLE_RETRY_MS') ?? 2000) * attempt)
  }
  return fail(`GitHub ${method} ${target} failed: ${last}`)
}

async function json(res, what) {
  if (!res.ok) fail(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

/** The PUBLISHED release for `tag`, or null (GitHub answers 404 for none, and for a draft). */
async function publishedRelease(tag) {
  const res = await github('GET', `/repos/${repo()}/releases/tags/${encodeURIComponent(tag)}`)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  return json(res, `reading the release for ${tag}`)
}

/** Every release, drafts included (a `contents: write` token sees drafts). */
async function allReleases() {
  const out = []
  for (let page = 1; page <= 20; page++) {
    const res = await github('GET', `/repos/${repo()}/releases?per_page=100&page=${page}`)
    const batch = await json(res, 'listing releases')
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

async function uploadAsset(release, name, bytes) {
  const url = `${String(release.upload_url).replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`
  const res = await github('POST', url, { body: bytes, contentType: 'application/gzip' })
  return json(res, `uploading ${name}`)
}

// ---- commands ----------------------------------------------------------------------------------

async function pack() {
  const tag = requireTag()
  const { toml, webDir, outdir, uiDir } = paths()
  if (!existsSync(outdir))
    fail(`build output not found: ${outdir} — run the wrangler dry run first`)
  if (!uiDir || !existsSync(uiDir))
    fail(`[assets] directory not found: ${uiDir} — build the UI first`)
  const entries = collectEntries({ worker: readTree(outdir), ui: readTree(uiDir) })
  const manifest = makeManifest({
    tag,
    version: env('RELEASE_VERSION') ?? tag,
    ...checkout(),
    toml,
    wranglerVersion: wranglerVersion(webDir),
    entries,
  })
  const file = env('BUNDLE_FILE') ?? path.join(webDir, 'dist', assetName(tag))
  mkdirSync(path.dirname(file), { recursive: true })
  const tgz = packBundle({ manifest, entries })
  writeFileSync(file, tgz)
  output('file', file)
  output('digest', manifest.bundleSha256)
  console.log(
    `packed ${Object.keys(entries).length} file(s) into ${file} (${(tgz.length / 1024).toFixed(0)} KB), ` +
      `bundleSha256 ${manifest.bundleSha256}`
  )
}

function readBundle(file) {
  if (!file) fail('usage: node scripts/bundle.mjs verify|attach <file>')
  if (!existsSync(file)) fail(`bundle not found: ${file}`)
  try {
    return unpackBundle(readFileSync(file))
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`)
  }
}

async function verify(file) {
  const tag = requireTag()
  const bundle = readBundle(file)
  verifyAgainstCheckout(bundle, { tag, toml: paths().toml })
  console.log(`${file} verified: bundleSha256 ${bundle.manifest.bundleSha256}`)
}

async function attach(file) {
  const tag = requireTag()
  const bundle = readBundle(file)
  verifyAgainstCheckout(bundle, { tag })
  const name = assetName(tag)
  const bytes = readFileSync(file)
  const plan = attachPlan(await allReleases(), tag)
  let release = plan.release
  if (plan.action === 'create-draft') {
    const res = await github('POST', `/repos/${repo()}/releases`, {
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        draft: true,
        prerelease: false,
        body:
          `Built once and deployed to staging by deploy.yml. Publishing this release deploys ` +
          `exactly these bytes to production (${name}, bundleSha256 ${bundle.manifest.bundleSha256}).\n`,
      }),
    })
    release = await json(res, `creating the draft release for ${tag}`)
    console.log(`created draft release ${release.id} for ${tag}`)
  }
  if (plan.action === 'keep') {
    console.log(
      `::warning::release ${tag} is published and already carries ${name}; its bytes are left as they are`
    )
    summary(`Release \`${tag}\` already carries \`${name}\`; left unchanged.`)
    return
  }
  if (plan.action === 'replace') {
    const res = await github('DELETE', `/repos/${repo()}/releases/assets/${plan.asset.id}`)
    if (!res.ok && res.status !== 404) fail(`deleting the old ${name}: ${res.status}`)
    console.log(`replacing ${name} on draft release ${release.id}`)
  }
  await uploadAsset(release, name, bytes)
  const state = release.draft ? 'draft' : 'published'
  console.log(`attached ${name} to ${state} release ${release.id} (${tag})`)
  summary(
    `Attached \`${name}\` (bundleSha256 \`${bundle.manifest.bundleSha256}\`) to the ${state} ` +
      `release \`${tag}\`.${release.draft ? ' Publishing it deploys these bytes to production.' : ''}`
  )
}

async function fetchBundle() {
  const tag = env('BUNDLE_TAG') ?? ''
  const deployer = Boolean(env('DEPLOYER_URL'))
  const release = deployer && tag ? await publishedRelease(tag) : null
  const plan = productionSource({ deployer, tag, release })
  if (plan.source === 'build') {
    output('source', 'build')
    console.log(`building from the tag: ${plan.reason}`)
    summary(`Production builds from the checkout: ${plan.reason}.`)
    return
  }
  if (plan.asset.size > MAX_BUNDLE_BYTES) fail(`${plan.asset.name} is ${plan.asset.size} bytes`)
  const res = await github('GET', `/repos/${repo()}/releases/assets/${plan.asset.id}`, {
    accept: 'application/octet-stream',
  })
  if (!res.ok) fail(`downloading ${plan.asset.name}: ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  let bundle
  try {
    bundle = unpackBundle(tgz)
  } catch (error) {
    fail(`${plan.asset.name} is unreadable: ${error.message}`)
  }
  const { toml, outdir, uiDir } = paths()
  verifyAgainstCheckout(bundle, { tag, toml })
  if (!uiDir) fail('the toml has no [assets] directory to unpack the UI into')
  const { worker, ui } = splitEntries(bundle.entries)
  writeTree(outdir, worker)
  writeTree(uiDir, ui)
  output('source', 'bundle')
  output('digest', bundle.manifest.bundleSha256)
  console.log(
    `deploying the staging bundle: ${Object.keys(worker).length} module(s), ` +
      `${Object.keys(ui).length} UI file(s), bundleSha256 ${bundle.manifest.bundleSha256}`
  )
  summary(
    `Production deploys the staging bundle \`${plan.asset.name}\` (bundleSha256 \`${bundle.manifest.bundleSha256}\`).`
  )
}

const COMMANDS = { pack, verify, attach, fetch: fetchBundle }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const name = process.argv[2]
  const command = COMMANDS[name]
  if (!command) {
    console.error(`usage: node scripts/bundle.mjs ${Object.keys(COMMANDS).join('|')}`)
    process.exit(2)
  }
  try {
    await command(process.argv[3])
  } catch (error) {
    const message = error instanceof BundleError ? error.message : (error?.stack ?? String(error))
    console.error(`::error::bundle ${name}: ${message}`)
    process.exit(1)
  }
}
