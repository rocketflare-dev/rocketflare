#!/usr/bin/env node
/**
 * Mechanical checks over the files a coding agent loads: every CLAUDE.md / AGENTS.md,
 * `.claude/rules/*.md` and `.claude/skills/*` (SKILL.md and its supporting markdown).
 *
 * It proves EXISTENCE, not correctness: a path, script or skill a doc names is still there, a
 * rule's globs still match something, a file is small enough to load whole, a skill's frontmatter
 * is one Claude Code accepts. Whether a line is true, needed or contradicted elsewhere is the
 * judgement half — SKILL.md beside this file. A pass is not more than that.
 *
 *   node .claude/skills/rf-agent-docs/check.mjs [--quiet]   # exit 1 on any ✖
 *
 * Zero dependencies; reads `git ls-files`, so worktrees, node_modules and ignored files are out.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const quiet = process.argv.includes('--quiet')

// Anthropic's numbers (code.claude.com/docs/en/memory, /skills; platform skill best practices).
const LIMITS = {
  memoryLines: 200, // "target under 200 lines per CLAUDE.md file"
  onDemandChars: 40_000, // nested / path-scoped files are capped per file on a 200K-context model
  skillBodyLines: 500, // "Keep the SKILL.md body under 500 lines"
  skillName: 64,
  skillDescription: 1024,
}

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => existsSync(path.join(ROOT, f)))
const fileSet = new Set(files)
const dirSet = new Set()
for (const f of files) {
  let d = path.posix.dirname(f)
  while (d !== '.' && !dirSet.has(d)) {
    dirSet.add(d)
    d = path.posix.dirname(d)
  }
}
const exists = (p) => fileSet.has(p) || dirSet.has(p.replace(/\/$/, ''))

const isMemory = (f) => /(^|\/)(CLAUDE|AGENTS|CLAUDE\.local)\.md$/.test(f)
const isRule = (f) => f.startsWith('.claude/rules/') && f.endsWith('.md')
const isSkillDoc = (f) => f.startsWith('.claude/skills/') && f.endsWith('.md')
const docs = files.filter((f) => isMemory(f) || isRule(f) || isSkillDoc(f))

const findings = []
const fail = (file, line, msg) => findings.push({ level: 'fail', file, line, msg })
const warn = (file, line, msg) => findings.push({ level: 'warn', file, line, msg })
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8')

// ── frontmatter (the flat subset rules and skills use) ─────────────────────────────────────────
function frontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end === -1) return null
  const out = {}
  let key = null
  for (const raw of text.slice(4, end).split('\n')) {
    const item = raw.match(/^\s+-\s+(.*)$/)
    if (item && key) {
      out[key] = [...(Array.isArray(out[key]) ? out[key] : []), unquote(item[1])]
      continue
    }
    const kv = raw.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      out[key] = kv[2] === '' ? [] : unquote(kv[2])
    }
  }
  return { data: out, bodyStart: text.slice(0, end).split('\n').length + 1 }
}
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',' && re.includes('(?:')) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}(?:/.*)?$`)
}

// ── 1. loading: what Claude Code actually reads ────────────────────────────────────────────────
function checkLoading() {
  const claude = path.join(ROOT, 'CLAUDE.md')
  const agents = path.join(ROOT, 'AGENTS.md')
  if (!existsSync(claude) && !existsSync(agents)) fail('.', 0, 'no root CLAUDE.md or AGENTS.md')
  if (existsSync(claude) && existsSync(agents)) {
    const link = lstatSync(agents).isSymbolicLink() ? readlinkSync(agents) : null
    if (link !== 'CLAUDE.md' && read('AGENTS.md') !== read('CLAUDE.md'))
      fail('AGENTS.md', 0, 'a second copy beside CLAUDE.md — Claude Code ignores AGENTS.md when CLAUDE.md exists; symlink it (`ln -sf CLAUDE.md AGENTS.md`)')
  }
  for (const f of files.filter((x) => x.endsWith('CLAUDE.local.md')))
    fail(f, 0, 'CLAUDE.local.md is personal — it must be gitignored, not tracked')
}

// ── 2. size: a file over budget is paid every session, or cut off ──────────────────────────────
function checkSize() {
  for (const f of docs) {
    const text = read(f)
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    const onDemand = f !== 'CLAUDE.md' && f !== 'AGENTS.md'
    if (onDemand && !isSkillDoc(f) && text.length > LIMITS.onDemandChars)
      fail(f, 0, `${text.length.toLocaleString()} chars — over the ${LIMITS.onDemandChars.toLocaleString()}-char per-file cap on a 200K-context model, so the tail is not read; split it or move detail into a skill`)
    if (isMemory(f) && lines > LIMITS.memoryLines)
      warn(f, 0, `${lines} lines — Anthropic's target is under ${LIMITS.memoryLines} per CLAUDE.md`)
    if (f === 'CLAUDE.md' && lines > LIMITS.memoryLines - 20 && lines <= LIMITS.memoryLines)
      warn(f, 0, `${lines} lines — within ${LIMITS.memoryLines - lines} of the ${LIMITS.memoryLines}-line target; adding a line means moving one`)
  }
}

// ── 3. rules: frontmatter Claude Code reads, globs that still match ────────────────────────────
function checkRules() {
  for (const f of docs.filter(isRule)) {
    const fm = frontmatter(read(f))
    if (!fm) {
      warn(f, 1, 'no frontmatter — loads in EVERY session; add `paths:` if it only concerns some files')
      continue
    }
    for (const k of Object.keys(fm.data))
      if (k !== 'paths') warn(f, 1, `frontmatter key \`${k}\` is ignored — rules read only \`paths\``)
    let globs = fm.data.paths
    if (globs === undefined) {
      warn(f, 1, 'no `paths:` — loads in every session')
      continue
    }
    if (typeof globs === 'string')
      globs = globs.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)
    for (const g of globs)
      if (!files.some((x) => globToRegExp(g).test(x)))
        fail(f, 1, `paths glob \`${g}\` matches no file — the rule never loads for it`)
  }
}

// ── 4. skills: frontmatter Claude Code and the API accept ──────────────────────────────────────
let descriptionChars = 0
function checkSkills() {
  const skillDirs = [...new Set(docs.filter(isSkillDoc).map((f) => f.split('/')[2]))]
  for (const dir of skillDirs) {
    const f = `.claude/skills/${dir}/SKILL.md`
    if (!fileSet.has(f)) {
      fail(`.claude/skills/${dir}`, 0, 'skill directory without a SKILL.md')
      continue
    }
    const text = read(f)
    const fm = frontmatter(text)
    if (!fm) {
      fail(f, 1, 'frontmatter must open on line 1 with `---`')
      continue
    }
    const { name, description } = fm.data
    if (name !== undefined && name !== dir) fail(f, 2, `name \`${name}\` ≠ directory \`${dir}\``)
    const n = name ?? dir
    if (!new RegExp(`^[a-z0-9-]{1,${LIMITS.skillName}}$`).test(n))
      fail(f, 2, `name \`${n}\` — lowercase letters, digits and hyphens, ≤ ${LIMITS.skillName}`)
    if (/anthropic|claude/.test(n)) fail(f, 2, `name \`${n}\` uses a reserved word`)
    if (!description || typeof description !== 'string') {
      fail(f, 2, 'no description — the model cannot tell when to use it')
      continue
    }
    if (description.length > LIMITS.skillDescription)
      fail(f, 2, `description ${description.length} chars (> ${LIMITS.skillDescription})`)
    if (/[<>]/.test(description)) fail(f, 2, 'description contains `<` or `>` (XML is rejected)')
    if (fm.data['disable-model-invocation'] !== 'true') descriptionChars += description.length
    const bodyLines = text.split('\n').length - fm.bodyStart
    if (bodyLines > LIMITS.skillBodyLines)
      warn(f, 0, `body ${bodyLines} lines (> ${LIMITS.skillBodyLines}) — move detail into a reference file`)
  }
  return skillDirs
}

// ── 5. references: links, backtick paths, pnpm scripts, /skills ────────────────────────────────
const pkgScripts = new Map()
function scriptsOf(pkgDir) {
  if (!pkgScripts.has(pkgDir)) {
    const p = path.join(ROOT, pkgDir, 'package.json')
    const json = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
    pkgScripts.set(pkgDir, { name: json.name, scripts: Object.keys(json.scripts ?? {}) })
  }
  return pkgScripts.get(pkgDir)
}
const packages = files.filter((f) => f.endsWith('package.json') && !f.includes('fixtures/'))
const byName = new Map(packages.map((p) => [scriptsOf(path.posix.dirname(p)).name, path.posix.dirname(p)]))
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'exec', 'dlx', 'run', 'why', 'update', 'up', 'list', 'ls', 'outdated', 'store', 'approve-builds', 'rebuild', 'link', 'import', 'audit', 'create', 'init', 'licenses', 'patch'])

function nearestPackage(f) {
  let d = path.posix.dirname(f)
  while (d !== '.') {
    if (fileSet.has(`${d}/package.json`)) return d
    d = path.posix.dirname(d)
  }
  return '.'
}

/** Candidate roots a doc's relative path may be written against. */
function bases(f) {
  const out = []
  let d = path.posix.dirname(f)
  while (true) {
    out.push(d)
    if (d === '.') break
    d = path.posix.dirname(d)
  }
  // Root-level docs name package-relative paths (`src/worker.ts` in apps/web).
  for (const p of packages) out.push(path.posix.dirname(p))
  return out
}
const all = [...fileSet, ...dirSet]
const ignored = (p) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT })
    return true
  } catch {
    return false
  }
}
/** A doc may write a path from the root, its own dir, or any sub-root (`routes/x.ts` in api/). */
const resolves = (f, p) => {
  const clean = p.replace(/^\.\//, '').replace(/\/$/, '')
  if (bases(f).some((b) => exists(path.posix.normalize(path.posix.join(b, p))))) return true
  // Module specifiers drop the extension: `services/ai/resolve`, `components/ai/Markdown`.
  const forms = ['', '.ts', '.tsx', '.mjs', '.js', '.md', '/index.ts'].map((e) => clean + e)
  if (forms.some((c) => bases(f).some((b) => exists(path.posix.normalize(path.posix.join(b, c))))))
    return true
  if (!clean.startsWith('../') && forms.some((c) => all.some((x) => x.endsWith(`/${c}`))))
    return true
  return ignored(clean) // `.dev.vars`, `.provision.env`: absent by design
}
// Placeholders in a path are a template, not a reference.
const PLACEHOLDER = /X\.Y\.Z|NNNN|\bfoo\b|<|\.\.\./

const topDirs = new Set([...dirSet].map((d) => d.split('/')[0]))
const anyDirName = new Set([...dirSet].map((d) => d.split('/').pop()))

function looksLikePath(tok) {
  if (PLACEHOLDER.test(tok)) return false
  if (/[\s*<>{}…$|=]|:\/\/|^@|^-|^\//.test(tok)) return false
  if (!tok.includes('/')) return false
  const first = tok.replace(/^\.\.?\//, '').split('/')[0]
  return tok.startsWith('./') || tok.startsWith('../') || topDirs.has(first) || anyDirName.has(first)
}

function checkReferences(skillDirs) {
  const scan = [...docs, ...(fileSet.has('README.md') ? ['README.md'] : [])]
  for (const f of scan) {
    const text = read(f)
    // A worked example of files that do not exist yet: `<!-- agent-docs-check: hypothetical -->`
    // (HTML comments are stripped before Claude Code injects a file, so the marker costs nothing).
    const hypothetical = text.includes('agent-docs-check: hypothetical')
    const own = nearestPackage(f)
    let fenced = false
    text.split('\n').forEach((line, i) => {
      const at = i + 1
      if (/^\s*```/.test(line)) fenced = !fenced
      if (f !== 'README.md') {
        for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^(https?:|mailto:|#)/.test(target)) continue
          const t = decodeURI(target.split('#')[0])
          if (t && !exists(path.posix.normalize(path.posix.join(path.posix.dirname(f), t))))
            fail(f, at, `link \`${target}\` does not resolve`)
        }
        if (!hypothetical)
          for (const [, raw] of line.matchAll(/`([^`\n]+)`/g)) {
            const tok = raw.replace(/:\d+(-\d+)?$/, '').replace(/[.,;]$/, '')
            if (looksLikePath(tok) && !resolves(f, tok)) warn(f, at, `path \`${raw}\` not found`)
          }
      }
      // Commands: only where they are written as commands — a fenced block or a code span.
      const code = fenced ? [line] : [...line.matchAll(/(?<!\bno )`([^`\n]+)`/g)].map((m) => m[1])
      for (const span of code)
        for (const m of span.matchAll(/(?:^|[\s;&|(])pnpm\s+((?:--?[\w-]+(?:[ =](?!-)\S+)?\s+)*)([\w:.*-]+)/g))
          checkScript(f, at, own, m[1], m[2], span.slice(m.index))
      for (const [, s] of line.matchAll(/(?:^|[\s`(])\/(rf-[a-z0-9-]+)/g))
        if (!skillDirs.includes(s)) fail(f, at, `\`/${s}\` — no such skill in .claude/skills`)
    })
  }
}

const webDir = () => byName.get('@rocketflare/web') ?? 'apps/web'
function checkScript(f, at, own, flags, script, rest) {
  if (PNPM_BUILTINS.has(script) || /^(-|\d)/.test(script) || /[*]|:$/.test(script)) return
  if (script === 'web' || /^web\s/.test(rest.replace(/^\S*pnpm\s+/, ''))) {
    const sub = rest.match(/pnpm\s+web\s+([\w:.-]+)/)?.[1]
    if (sub && !PNPM_BUILTINS.has(sub) && !scriptsOf(webDir()).scripts.includes(sub))
      fail(f, at, `\`pnpm web ${sub}\` — no such script in ${webDir()}`)
    return
  }
  const filter = flags.match(/--filter[ =](\S+)/)?.[1]
  if (filter) {
    const pkg = byName.get(filter)
    if (!pkg) fail(f, at, `\`pnpm --filter ${filter}\` — no workspace package by that name`)
    else if (!PNPM_BUILTINS.has(script) && !scriptsOf(pkg).scripts.includes(script))
      fail(f, at, `\`pnpm --filter ${filter} ${script}\` — no such script`)
    return
  }
  if (scriptsOf('.').scripts.includes(script) || scriptsOf(own).scripts.includes(script)) return
  const elsewhere = [...byName.values()].filter((d) => scriptsOf(d).scripts.includes(script))
  if (elsewhere.length)
    warn(f, at, `\`pnpm ${script}\` is a ${elsewhere.join(', ')} script, not a root one — from the root it fails; write \`pnpm --filter ${scriptsOf(elsewhere[0]).name} ${script}\` or say where to run it`)
  else fail(f, at, `\`pnpm ${script}\` — no such script in any package`)
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
checkLoading()
checkSize()
checkRules()
const skillDirs = checkSkills()
checkReferences(skillDirs)

const fails = findings.filter((x) => x.level === 'fail')
const warns = findings.filter((x) => x.level === 'warn')
for (const x of quiet ? fails : findings)
  console.log(`${x.level === 'fail' ? '✖' : '!'} ${x.file}${x.line ? `:${x.line}` : ''}  ${x.msg}`)
const memory = docs.filter(isMemory).length
console.log(
  `\n${docs.length} agent docs (${memory} CLAUDE/AGENTS, ${docs.filter(isRule).length} rules, ${skillDirs.length} skills); ` +
    `skill descriptions in every session: ${descriptionChars.toLocaleString()} chars`,
)
console.log(fails.length ? `✖ agent docs: ${fails.length} failure(s), ${warns.length} warning(s)` : `✔ agent docs ok (${warns.length} warning(s))`)
process.exit(fails.length ? 1 : 0)
