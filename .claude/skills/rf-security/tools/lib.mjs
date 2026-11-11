// Shared helpers for the audit runner (`audit.mjs`). No dependencies beyond Node.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TOOLS = import.meta.dirname
export const SKILL = path.dirname(TOOLS)
export const UPSTREAM = path.join(SKILL, 'upstream')
export const REPO = path.resolve(SKILL, '../../..')

/** Where every run lives. `RF_SECURITY_RUNS` exists for the runner's own tests. */
export const runsRoot = () =>
  process.env.RF_SECURITY_RUNS ?? path.join(os.homedir(), '.rocketflare', 'security-runs')
export const markerPath = () => path.join(runsRoot(), '.active')

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export const exists = file => fs.existsSync(file)
export const readUpstream = name => fs.readFileSync(path.join(UPSTREAM, name), 'utf8')

/** Writes a file that must not exist yet: the runner never overwrites evidence. */
export function writeNew(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { flag: 'wx' })
}
export const writeJsonNew = (file, value) => writeNew(file, `${JSON.stringify(value, null, 2)}\n`)

/** Writes or replaces a parent-owned file (metadata, briefs, derived lists). */
export function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
export const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)

/** Keeps the first copy of a shared file before a step changes it: `<name>.before-<step>.json`. */
export function keepBefore(file, step) {
  const before = file.replace(/\.json$/, `.before-${step}.json`)
  if (!exists(before)) fs.copyFileSync(file, before, fs.constants.COPYFILE_EXCL)
  return before
}

/** Percent-encodes a coverage-id segment the way upstream's validator expects. */
export const encodeSegment = value =>
  [...Buffer.from(value, 'utf8')]
    .map(b =>
      /[A-Za-z0-9\-._~]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    )
    .join('')
export const coverageId = refs =>
  [refs.surface, refs.boundary, refs.subsystem, refs.attack_class].map(encodeSegment).join('::')

/** A bold-headed attack-class block (`**Name**` … up to the next block or heading). */
export function block(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(`**${name}**`))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !/^(\*\*[^*]+\*\*( \(subagent.*)?$|#{1,4} )/.test(lines[end])) end++
  return lines.slice(start, end).join('\n').trim()
}

/** A `## Heading` section, up to the next `## `. */
export function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(`## ${heading}`))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end++
  return lines.slice(start, end).join('\n').trim()
}

/** The first ```text fence after an anchor: upstream's verbatim prompt blocks. */
export function fence(text, anchor) {
  const at = text.indexOf(anchor)
  if (at === -1) throw new Error(`upstream anchor missing: ${anchor}`)
  const from = text.indexOf('```text', at)
  return text.slice(from + 8, text.indexOf('\n```', from + 7))
}

/** Companion files by the one-letter code a plan uses (`W:SAML signed-object…`); O is ordinary. */
export const COMPANIONS = {
  D: 'DATA-ISOLATION-AND-LIFECYCLE.md',
  W: 'WEB-PROTOCOL-AND-AUTH.md',
  L: 'AI-AND-LLM.md',
  C: 'CLIENT-SIDE.md',
  P: 'PROTOCOLS-RPC-AND-MESSAGING.md',
  S: 'SUPPLY-CHAIN-AND-RELEASE.md',
  R: 'RESOURCE-EXHAUSTION-AND-AVAILABILITY.md',
  O: 'ATTACK-CLASSES.md',
}
export const COMPANION_SECTIONS = ['Core discipline', 'Universal moves', 'Validation rules']

function* strings(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const v of value) yield* strings(v)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v)
}

function objectAt(text, key, accept) {
  const start = text.search(new RegExp(`\\{\\s*"${key}"\\s*:`))
  if (start === -1) return null
  const end = text.lastIndexOf('}')
  if (end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return accept(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The agent's final JSON object whose first key is `key`, from a plain JSON file, a text file, or
 * a JSONL transcript (the last match wins, so the final report beats a quoted draft).
 */
export function extractResult(file, key, accept) {
  const text = fs.readFileSync(file, 'utf8')
  try {
    const whole = JSON.parse(text)
    if (accept(whole)) return whole
  } catch {}
  let found = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (accept(parsed)) found = parsed
    for (const s of strings(parsed)) if (s.includes(`"${key}"`)) found = objectAt(s, key, accept) ?? found
  }
  return found ?? objectAt(text, key, accept)
}

export const MAX_ARTIFACT = 1024 * 1024

/**
 * Copies an agent's proofs and logs from scratch/ and poc/ into its parent-owned artifacts/. Only
 * regular, single-link files under the size bound; never a symlink, never a directory, never an
 * overwrite. Agents never write artifacts/ themselves.
 */
export function promoteArtifacts(agentDir) {
  const to = path.join(agentDir, 'artifacts')
  fs.mkdirSync(to, { recursive: true })
  let copied = 0
  for (const [sub, keep] of [
    ['poc', n => n.endsWith('.test.ts')],
    ['scratch', n => n.endsWith('.log')],
  ]) {
    const from = path.join(agentDir, sub)
    if (!exists(from)) continue
    for (const name of fs.readdirSync(from)) {
      if (!keep(name) || name.includes('/') || name.startsWith('.')) continue
      const source = path.join(from, name)
      const stat = fs.lstatSync(source)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARTIFACT) continue
      const target = path.join(to, name)
      if (exists(target)) continue
      const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const again = fs.fstatSync(fd)
        if (again.ino !== stat.ino || again.size !== stat.size || !again.isFile()) continue
        const bytes = Buffer.alloc(again.size)
        fs.readSync(fd, bytes, 0, again.size, 0)
        fs.writeFileSync(target, bytes, { flag: 'wx' })
        copied++
      } finally {
        fs.closeSync(fd)
      }
    }
  }
  return copied
}

/** Runs one of upstream's validators; returns { ok, output }. */
export function validate(validator, file) {
  const r = spawnSync('node', [path.join(UPSTREAM, validator), file], { encoding: 'utf8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() }
}

/** Installs `next` over `target` only when every validator passes; otherwise leaves `next`. */
export function installIfValid(pairs) {
  const results = pairs.map(([validator, next]) => ({ validator, next, ...validate(validator, next) }))
  for (const r of results) {
    console.log(`${r.validator}: ${r.ok ? 'ok' : 'FAILED'}`)
    if (!r.ok) console.log(r.output.split('\n').slice(0, 30).join('\n'))
  }
  if (results.every(r => r.ok)) {
    for (const r of results) fs.renameSync(r.next, r.next.replace(/\.next\.json$/, '.json'))
    return true
  }
  console.log('NOT installed: the .next.json files are left for inspection')
  return false
}

export const sevRank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 }
export const countBy = (items, key) => {
  const out = {}
  for (const item of items) {
    const k = typeof key === 'function' ? key(item) : item[key]
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
export const byString = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0)
