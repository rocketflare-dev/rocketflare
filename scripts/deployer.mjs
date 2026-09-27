#!/usr/bin/env node
// Deploy through an external deployer (docs/DEPLOYER.md, protocol v1).
//
// The deploy job's side of the protocol. `.github/workflows/deploy.yml` takes this path when the
// repository variable DEPLOYER_URL is set: the job then holds NO Cloudflare token and NO database
// credential. It proves who it is with a GitHub Actions OIDC token, minted fresh for every call, and
// the deployer checks the build, deploys it and hands out short-lived migration credentials.
//
//   node scripts/deployer.mjs start      open a ticket, wait for approval   → $GITHUB_ENV DEPLOYER_TICKET
//   node scripts/deployer.mjs upload     send the built Worker + assets     → $GITHUB_ENV MIGRATOR_URL (masked)
//   node scripts/deployer.mjs activate   the deployer makes the uploaded version live
//   node scripts/deployer.mjs finish     always last (`if: always()`); a no-op without a ticket
//
// Environment:
//   DEPLOYER_URL          the deployer's base URL (required)
//   DEPLOYER_AUDIENCE     the OIDC audience; default: the origin of DEPLOYER_URL
//   DEPLOYER_TICKET       set by `start` through $GITHUB_ENV; read by every later command
//   TOML                  the wrangler config deployed, e.g. apps/web/wrangler.staging.toml
//   DEPLOYER_OUTDIR       the `wrangler deploy --dry-run --outdir` directory; default: dist/deploy
//                         next to TOML
//   RELEASE_VERSION       the version the deployer sets as the Worker's RELEASE_VERSION var
//   WAIT_SECONDS          how long `start` waits for approval (default 300)
//   DEPLOYER_POLL_SECONDS how often `start` asks (default 10)
//   ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN — set by GitHub Actions when the
//                         job has `permissions: id-token: write`
//   GITHUB_ENV            the file a step appends `NAME=value` lines to, for the later steps
//
// Node only, no dependencies: it runs before `pnpm install` would matter and must stay auditable.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL = 1

const env = name => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

class DeployerError extends Error {}
const fail = message => {
  throw new DeployerError(message)
}

/** The deployer's base URL, without a trailing slash. */
function baseUrl() {
  const raw = env('DEPLOYER_URL') ?? fail('DEPLOYER_URL is not set')
  try {
    const url = new URL(raw)
    return url.href.replace(/\/+$/, '')
  } catch {
    return fail(`DEPLOYER_URL is not a URL: ${raw}`)
  }
}

function audience() {
  return env('DEPLOYER_AUDIENCE') ?? new URL(baseUrl()).origin
}

/** A fresh GitHub Actions OIDC token for the deployer's audience. Never logged. */
async function oidcToken() {
  const requestUrl = env('ACTIONS_ID_TOKEN_REQUEST_URL')
  const requestToken = env('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
  if (!requestUrl || !requestToken) {
    fail(
      'no GitHub Actions OIDC token available (ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN unset) — ' +
        'the job needs `permissions: id-token: write`'
    )
  }
  const url = new URL(requestUrl)
  url.searchParams.set('audience', audience())
  let res
  try {
    res = await fetch(url, { headers: { authorization: `bearer ${requestToken}` } })
  } catch (error) {
    return fail(`could not reach the OIDC token endpoint: ${error.message}`)
  }
  if (!res.ok) fail(`the OIDC token endpoint answered ${res.status}`)
  const body = await res.json().catch(() => ({}))
  if (typeof body.value !== 'string' || !body.value)
    fail('the OIDC token endpoint returned no token')
  return body.value
}

/** Keys a response may carry that must never reach a log. */
const SECRET_KEYS = new Set(['migratorUrl'])
const redact = body =>
  body && typeof body === 'object'
    ? Object.fromEntries(Object.entries(body).filter(([k]) => !SECRET_KEYS.has(k)))
    : body

/** One call to the deployer, with a fresh token. Returns `{ status, body }`. */
async function call(method, route, payload) {
  const token = await oidcToken()
  let res
  try {
    res = await fetch(`${baseUrl()}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  } catch (error) {
    return { status: 0, body: { error: `could not reach the deployer: ${error.message}` } }
  }
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { error: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const ok = status => status >= 200 && status < 300
const explain = ({ status, body }) => {
  const safe = redact(body)
  const message = typeof safe?.error === 'string' ? safe.error : JSON.stringify(safe)
  return `${status} ${message}`
}

/** Append `NAME=value` to $GITHUB_ENV so the job's later steps see it. */
function exportEnv(name, value) {
  const file =
    env('GITHUB_ENV') ?? fail('GITHUB_ENV is not set — run this inside a GitHub Actions job')
  if (/[\r\n]/.test(value)) fail(`refusing to export ${name}: the value spans lines`)
  appendFileSync(file, `${name}=${value}\n`)
}

function ticket() {
  const id = env('DEPLOYER_TICKET') ?? fail('DEPLOYER_TICKET is not set — `start` must run first')
  return encodeURIComponent(id)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function start() {
  const opened = await call('POST', '/deploy/start', { protocol: PROTOCOL })
  if (!ok(opened.status)) fail(`start refused: ${explain(opened)}`)
  const id = opened.body?.id
  if (typeof id !== 'string' || !id) fail(`start answered without a ticket id: ${explain(opened)}`)
  exportEnv('DEPLOYER_TICKET', id)
  console.log(`ticket ${id}: ${opened.body.status ?? 'pending'}`)

  const waitSeconds = Number(env('WAIT_SECONDS') ?? 300)
  const pollMs = Number(env('DEPLOYER_POLL_SECONDS') ?? 10) * 1000
  const deadline = Date.now() + waitSeconds * 1000
  let status = opened.body.status
  for (;;) {
    if (status === 'approved') break
    if (status === 'rejected') fail(`ticket ${id} was rejected by the deployer`)
    if (status && !['pending', 'approved'].includes(status)) {
      fail(`ticket ${id} is ${status}; expected pending or approved`)
    }
    if (Date.now() >= deadline) {
      fail(`ticket ${id} not approved within ${waitSeconds}s (status ${status ?? 'unknown'})`)
    }
    console.log(`waiting for approval (status ${status ?? 'unknown'})`)
    await sleep(pollMs)
    const polled = await call('GET', `/deploy/${encodeURIComponent(id)}`)
    if (ok(polled.status)) status = polled.body?.status
    else if (polled.status === 0 || polled.status >= 500) {
      console.log(`deployer unavailable (${explain(polled)}); retrying`)
    } else fail(`polling ticket ${id} failed: ${explain(polled)}`)
  }
  console.log(`ticket ${id} approved`)
}

/** Read `main` and `[assets] directory` from a wrangler toml without a TOML parser. */
export function readToml(text) {
  const main = text.match(/^\s*main\s*=\s*["']([^"']+)["']/m)?.[1]
  let assetsDirectory
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/)
    if (header) {
      section = header[1]
      continue
    }
    if (section === 'assets') {
      const dir = line.match(/^\s*directory\s*=\s*["']([^"']+)["']/)
      if (dir) assetsDirectory = dir[1]
    }
  }
  return { main, assetsDirectory }
}

/** Every file under `dir`, as posix paths relative to it. */
function files(dir) {
  const out = []
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out
}

/** The upload body (docs/DEPLOYER.md → Upload payload). */
export function buildPayload({ tomlPath, outdir, version }) {
  if (!existsSync(tomlPath)) fail(`TOML not found: ${tomlPath}`)
  const toml = readFileSync(tomlPath, 'utf8')
  const { main, assetsDirectory } = readToml(toml)
  if (!main) fail(`${tomlPath} has no \`main\``)
  if (!existsSync(outdir)) {
    fail(`build output not found: ${outdir} — run \`wrangler deploy --dry-run --outdir\` first`)
  }

  // Every module wrangler wrote (JS chunks, .wasm, .bin, .txt …), never the source maps nor the
  // README wrangler drops into the outdir.
  const modules = {}
  for (const rel of files(outdir)) {
    if (rel.endsWith('.map') || rel === 'README.md') continue
    modules[rel] = readFileSync(path.join(outdir, rel)).toString('base64')
  }
  const entry = `${path.posix.basename(main).replace(/\.[cm]?[jt]sx?$/, '')}.js`
  if (!(entry in modules)) {
    fail(`entry module ${entry} (from main = "${main}") is not in ${outdir}`)
  }

  const assets = {}
  if (assetsDirectory) {
    const dir = path.resolve(path.dirname(tomlPath), assetsDirectory)
    if (!existsSync(dir)) fail(`[assets] directory not found: ${dir} — build the UI first`)
    for (const rel of files(dir)) {
      if (rel === '.assetsignore') continue
      assets[`/${rel}`] = readFileSync(path.join(dir, rel)).toString('base64')
    }
  }
  return { protocol: PROTOCOL, version, main: entry, toml, modules, assets }
}

async function upload() {
  const tomlPath = env('TOML') ?? fail('TOML is not set (e.g. apps/web/wrangler.staging.toml)')
  const version = env('RELEASE_VERSION') ?? fail('RELEASE_VERSION is not set')
  const outdir = env('DEPLOYER_OUTDIR') ?? path.join(path.dirname(tomlPath), 'dist/deploy')
  const id = ticket()
  const payload = buildPayload({ tomlPath, outdir, version })
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  console.log(
    `uploading ${Object.keys(payload.modules).length} module(s), ` +
      `${Object.keys(payload.assets).length} asset(s), ${(bytes / 1024 / 1024).toFixed(1)} MB, version ${version}`
  )
  const res = await call('POST', `/deploy/${id}/upload`, payload)
  if (res.status !== 200) fail(`upload refused: ${explain(res)}`)
  const migratorUrl = res.body?.migratorUrl
  if (typeof migratorUrl !== 'string' || !migratorUrl) {
    fail('upload accepted but the deployer returned no migratorUrl')
  }
  let password = ''
  try {
    password = new URL(migratorUrl).password
  } catch {
    fail('upload accepted but migratorUrl is not a URL')
  }
  // Mask before anything else could echo it; the percent-decoded form too, as a tool may print it.
  console.log(`::add-mask::${migratorUrl}`)
  if (password) {
    console.log(`::add-mask::${password}`)
    const decoded = decodeURIComponent(password)
    if (decoded !== password) console.log(`::add-mask::${decoded}`)
  }
  exportEnv('MIGRATOR_URL', migratorUrl)
  console.log(`upload accepted: ${JSON.stringify(redact(res.body))}`)
}

async function activate() {
  const res = await call('POST', `/deploy/${ticket()}/activate`)
  if (res.status !== 200) fail(`activate refused: ${explain(res)}`)
  console.log(`activated: ${res.body?.status ?? 'active'}`)
}

async function finish() {
  if (!env('DEPLOYER_TICKET')) {
    console.log('no ticket, nothing to finish')
    return
  }
  const res = await call('POST', `/deploy/${ticket()}/finish`)
  if (!ok(res.status)) fail(`finish failed: ${explain(res)}`)
  console.log(`finished: ${res.body?.status ?? 'finished'}`)
}

const COMMANDS = { start, upload, activate, finish }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const name = process.argv[2]
  const command = COMMANDS[name]
  if (!command) {
    console.error(`usage: node scripts/deployer.mjs ${Object.keys(COMMANDS).join('|')}`)
    process.exit(2)
  }
  try {
    await command()
  } catch (error) {
    const message = error instanceof DeployerError ? error.message : (error?.stack ?? String(error))
    console.error(`::error::deployer ${name}: ${message}`)
    process.exit(1)
  }
}
