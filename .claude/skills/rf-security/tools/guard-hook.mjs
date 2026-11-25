#!/usr/bin/env node
/**
 * PreToolUse guard for a security audit (`.claude/settings.json`). Inert unless an audit is active
 * (`~/.rocketflare/security-runs/.active`, written by `audit.mjs init`, removed by `finish`).
 *
 * A skill's own frontmatter hooks do not reach the subagents it spawns, but settings hooks do, so
 * the guard lives here. While an audit runs it refuses, for the parent and every subagent:
 *   - deleting, moving or truncating anything (rm, rmdir, unlink, mv, find -delete, git clean …)
 *   - resetting HOME, reading .dev.vars / .provision.env / ~/.rocketflare/config.json
 *   - Write/Edit outside the run directory (a subagent: outside agents/<id>/scratch|poc)
 *   - output redirection or tee outside the run directory
 *   - for a subagent: pnpm, npm, npx, docker (target code runs only through the sandbox script)
 * A Bash command is tokenized the way a POSIX shell would (quotes, escapes, separators,
 * redirections, substitutions, here-documents), so `rm` inside a quoted message is text and `=>`
 * inside `node -e '…'` is not a redirect. What it cannot parse confidently it refuses.
 * Exit 2 blocks the call and tells the agent why. Post-wave, `audit.mjs guard check` catches
 * whatever slips past.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.env.RF_SECURITY_RUNS ?? path.join(os.homedir(), '.rocketflare', 'security-runs')
const marker = path.join(root, '.active')

// ---------------------------------------------------------------------------------------------
// Tokenizer

export class ShellParseError extends Error {}

/**
 * Parses a shell command line into a list of items: `{ type: 'cmd', words, redirects }`,
 * `{ type: 'open' }` and `{ type: 'close' }` (a subshell). A word is a list of parts: `{ text,
 * glob? }`, `{ var }`, `{ unknown: true }` (an expansion with no static value), `{ sub: items }`
 * (a command or process substitution) and `{ tilde: true }`. Throws ShellParseError on anything
 * it does not understand.
 */
export function parseShell(src) {
  let i = 0
  const heredocs = []
  const fail = why => {
    throw new ShellParseError(why)
  }

  function readHeredocBodies() {
    for (const h of heredocs.splice(0)) {
      for (;;) {
        if (i >= src.length) fail(`unterminated here-document (${h.delim})`)
        let end = src.indexOf('\n', i)
        if (end === -1) end = src.length
        let line = src.slice(i, end)
        i = Math.min(end + 1, src.length)
        if (h.strip) line = line.replace(/^\t+/, '')
        if (line === h.delim) break
        if (!h.quoted && /\$\(|`/.test(line)) fail('a command substitution inside a here-document')
      }
    }
  }

  function readDollar(parts, inDouble, term) {
    i++
    const c = src[i]
    if (c === '(') {
      i++
      parts.push({ sub: readList(')') })
      return
    }
    if (c === '{') {
      const end = src.indexOf('}', i)
      if (end === -1) fail('unterminated ${')
      const inner = src.slice(i + 1, end)
      i = end + 1
      parts.push(/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? { var: inner } : { unknown: true })
      return
    }
    if (c === "'" && !inDouble) {
      // ANSI-C quoting: $'…' with backslash escapes.
      i++
      let text = ''
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', e: '\x1b' }
      while (src[i] !== "'") {
        if (i >= src.length) fail("unterminated $'")
        if (src[i] === '\\') {
          text += esc[src[i + 1]] ?? src[i + 1]
          i += 2
        } else text += src[i++]
      }
      i++
      parts.push({ text, q: true })
      return
    }
    if (c === '"' && !inDouble) return // $"…" is a double-quoted string
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
      i += m[0].length
      parts.push({ var: m[0] })
      return
    }
    if (c !== undefined && /[0-9@*#?$!-]/.test(c)) {
      i++
      parts.push({ unknown: true })
      return
    }
    if (term === '`' && c === '`') fail('a lone $ before a closing backtick')
    parts.push({ text: '$' })
  }

  function readWord(term) {
    const parts = []
    const start = i
    for (;;) {
      const c = src[i]
      if (c === undefined) break
      if (/[\s;&|<>()]/.test(c)) break
      if (c === '`' && term === '`') break
      if (c === '\\') {
        if (src[i + 1] === '\n') {
          i += 2
          continue
        }
        if (i + 1 >= src.length) fail('a trailing backslash')
        parts.push({ text: src[i + 1], q: true })
        i += 2
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1)
        if (end === -1) fail('an unterminated single quote')
        parts.push({ text: src.slice(i + 1, end), q: true })
        i = end + 1
      } else if (c === '"') {
        i++
        for (;;) {
          const d = src[i]
          if (d === undefined) fail('an unterminated double quote')
          if (d === '"') {
            i++
            break
          }
          if (d === '\\' && /[$`"\\\n]/.test(src[i + 1] ?? '')) {
            if (src[i + 1] !== '\n') parts.push({ text: src[i + 1], q: true })
            i += 2
          } else if (d === '$') readDollar(parts, true, term)
          else if (d === '`') {
            i++
            parts.push({ sub: readList('`') })
          } else {
            parts.push({ text: d, q: true })
            i++
          }
        }
      } else if (c === '$') readDollar(parts, false, term)
      else if (c === '`') {
        i++
        parts.push({ sub: readList('`') })
      } else if (c === '~' && i === start) {
        const after = src[i + 1]
        if (after === undefined || after === '/' || /[\s;&|<>()]/.test(after)) parts.push({ tilde: true })
        else fail('~user expansion')
        i++
      } else {
        parts.push(/[*?[]/.test(c) ? { text: c, glob: true } : { text: c })
        i++
      }
    }
    return parts
  }

  function readList(term) {
    const items = []
    let words = []
    let redirects = []
    let depth = 0
    const flush = () => {
      if (words.length || redirects.length) items.push({ type: 'cmd', words, redirects })
      words = []
      redirects = []
    }
    const readRedirect = fd => {
      const m = /^(&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(src.slice(i))
      const op = m[0]
      i += op.length
      if ((op === '<' || op === '>') && src[i] === '(') {
        i++
        words.push([{ sub: readList(')') }])
        return
      }
      while (src[i] === ' ' || src[i] === '\t') i++
      const target = readWord(term)
      if (!target.length) fail(`a ${op} with no target`)
      if (op === '<<' || op === '<<-') {
        if (target.some(p => p.text === undefined)) fail('an expanded here-document delimiter')
        const quoted = target.some(p => p.q)
        heredocs.push({ delim: target.map(p => p.text).join(''), strip: op === '<<-', quoted })
        return
      }
      redirects.push({ op, fd, target })
    }
    for (;;) {
      const c = src[i]
      if (c === undefined) {
        if (term) fail(term === ')' ? 'an unterminated $(' : 'an unterminated backtick')
        if (depth) fail('an unbalanced (')
        if (heredocs.length) fail('an unterminated here-document')
        flush()
        return items
      }
      if (c === ' ' || c === '\t') {
        i++
        continue
      }
      if (c === '\\' && src[i + 1] === '\n') {
        i += 2
        continue
      }
      if (c === '\n') {
        flush()
        i++
        if (heredocs.length) readHeredocBodies()
        continue
      }
      if (c === '#') {
        // A # at the start of a word starts a comment (inside a word it is text).
        while (i < src.length && src[i] !== '\n') i++
        continue
      }
      if (term === '`' && c === '`') {
        i++
        if (depth) fail('an unbalanced ( inside backticks')
        flush()
        return items
      }
      if (c === ')') {
        i++
        flush()
        if (depth > 0) {
          depth--
          items.push({ type: 'close' })
          continue
        }
        if (term === ')') return items
        fail('an unbalanced )')
      }
      if (c === '(') {
        if (words.length || redirects.length) fail('a ( inside a command (arrays, functions)')
        i++
        depth++
        items.push({ type: 'open' })
        continue
      }
      if (c === '&' && src[i + 1] === '>') {
        readRedirect(null)
        continue
      }
      if (c === ';' || c === '&' || c === '|') {
        const op = /^(&&|\|\||;;|\|&|[;&|])/.exec(src.slice(i))[0]
        if (op === ';;') fail('a case statement')
        i += op.length
        flush()
        continue
      }
      if (c === '>' || c === '<') {
        readRedirect(null)
        continue
      }
      const fd = /^[0-9]+(?=[<>])/.exec(src.slice(i))
      if (fd) {
        i += fd[0].length
        readRedirect(fd[0])
        continue
      }
      const word = readWord(term)
      if (!word.length) fail(`an unexpected ${JSON.stringify(c)}`)
      words.push(word)
    }
  }

  return readList(null)
}

// ---------------------------------------------------------------------------------------------
// Judging the parsed command

const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'fi', 'done'])
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'srm'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'nice', 'command', 'builtin', 'exec', 'stdbuf', 'caffeinate', 'time'])
const PACKAGE_TOOLS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'docker', 'wrangler'])
/** Options that take a value, per wrapper, so the wrapped command is found after them. */
const VALUE_OPTIONS = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  nice: ['-n'],
  stdbuf: ['-i', '-o', '-e'],
  env: ['-u', '-C', '-P'],
  timeout: ['-k', '-s', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a', '-J', '-R', '-S'],
}
const DEV = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/
const MAX_DEPTH = 6

const value = (word, st) => {
  let out = ''
  let known = true
  let glob = false
  for (const p of word) {
    if (p.text !== undefined) {
      out += p.text
      if (p.glob) glob = true
    } else if (p.tilde) out += st.home
    else if (p.var !== undefined) {
      if (p.var === 'HOME') out += st.home
      else if (p.var === 'PWD' && st.cwd) out += st.cwd
      else if (st.vars.has(p.var)) out += st.vars.get(p.var)
      else known = false
    } else known = false
  }
  return { value: out, known, glob }
}

const subsOf = word => word.filter(p => p.sub).map(p => p.sub)
const clone = st => ({ ...st, vars: new Map(st.vars) })

/** Skips a wrapper's options (and their values) and returns the wrapped command's words. */
function afterOptions(name, args) {
  const takes = VALUE_OPTIONS[name] ?? []
  let k = 0
  while (k < args.length && args[k].known && args[k].value.startsWith('-') && args[k].value !== '-') {
    if (args[k].value === '--') return args.slice(k + 1)
    if (takes.includes(args[k].value)) k++
    k++
  }
  return args.slice(k)
}

function judgeList(items, st, ctx) {
  const stack = []
  for (const item of items) {
    if (item.type === 'open') stack.push(clone(st))
    else if (item.type === 'close') Object.assign(st, stack.pop())
    else {
      const why = judgeCommand(item, st, ctx)
      if (why) return why
    }
  }
  return null
}

function judgeCommand(cmd, st, ctx) {
  for (const w of [...cmd.words, ...cmd.redirects.map(r => r.target)]) {
    for (const sub of subsOf(w)) {
      const why = judgeList(sub, clone(st), ctx)
      if (why) return why
    }
  }
  for (const r of cmd.redirects) {
    const t = value(r.target, st)
    if (['<', '<&', '<<<'].includes(r.op)) continue
    if ((r.op === '>&' || r.op === '<&') && t.known && /^(\d+|-)$/.test(t.value)) continue
    const why = ctx.writeTarget(t, st, 'redirecting output to')
    if (why) return why
  }
  const words = cmd.words.map(w => value(w, st))
  let k = 0
  const assigns = []
  while (k < words.length) {
    // Only an unquoted NAME= at the start of a word is an assignment.
    const lead = []
    for (const p of cmd.words[k]) {
      if (p.text === undefined || p.q) break
      lead.push(p.text)
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(lead.join(''))
    if (!m) break
    assigns.push([m[1], m[2] ? { ...words[k], known: false } : words[k]])
    k++
  }
  for (const [name] of assigns) if (name === 'HOME') return 'resetting HOME'
  if (k === words.length) {
    for (const [name, w] of assigns) setVar(st, name, w)
    return null
  }
  return judgeArgv(words.slice(k), st, ctx, 0)
}

function setVar(st, name, w) {
  const eq = w.value.indexOf('=')
  if (w.known) st.vars.set(name, w.value.slice(eq + 1))
  else st.vars.delete(name)
}

function judgeArgv(argv, st, ctx, depth) {
  if (depth > MAX_DEPTH) return 'commands nested too deeply to check'
  let a = argv
  while (a.length && a[0].known && KEYWORDS.has(a[0].value)) a = a.slice(1)
  if (!a.length) return null
  const head = a[0]
  if (!head.known || head.glob) return 'running a command whose name the guard cannot resolve'
  const name = path.basename(head.value)
  const args = a.slice(1)
  const known = args.every(x => x.known)
  if (DELETERS.has(name)) return 'deleting files'
  if (name === 'mv') return 'moving files'
  if (ctx.sub && PACKAGE_TOOLS.has(name)) return 'package managers and docker (use the sandbox command)'
  switch (name) {
    case 'for':
    case 'select':
      return null
    case 'case':
    case 'function':
      return 'a shell construct the guard does not parse (case, function)'
    case 'cd': {
      const to = args.find(x => !(x.known && /^-[LPe@]+$/.test(x.value)))
      if (!to) st.cwd = st.home
      else if (to.known && !to.glob && to.value !== '-' && (st.cwd || path.isAbsolute(to.value))) {
        st.cwd = path.resolve(st.cwd ?? '/', to.value)
      } else st.cwd = null
      return null
    }
    case 'pushd':
    case 'popd':
      st.cwd = null
      return null
    case 'export':
    case 'declare':
    case 'typeset':
    case 'local':
    case 'readonly':
      for (const x of args) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(x.value)
        if (!m) continue
        if (m[1] === 'HOME') return 'resetting HOME'
        setVar(st, m[1], x)
      }
      return null
    case 'unset':
      if (args.some(x => !x.known || x.value === 'HOME')) return 'resetting HOME'
      for (const x of args) st.vars.delete(x.value)
      return null
    case 'env': {
      const rest = afterOptions('env', args)
      if (args.some(x => x.known && /^-(S|-split-string)/.test(x.value))) return 'env -S (the guard cannot split its string)'
      let k = 0
      while (k < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[k].value)) {
        if (rest[k].value.startsWith('HOME=')) return 'resetting HOME'
        k++
      }
      return judgeArgv(rest.slice(k), st, ctx, depth + 1)
    }
    case 'timeout': {
      const rest = afterOptions('timeout', args)
      return judgeArgv(rest.slice(1), st, ctx, depth + 1)
    }
    case 'xargs':
      return judgeArgv(afterOptions('xargs', args), st, ctx, depth + 1)
    case 'eval': {
      if (!known) return 'eval of a string the guard cannot resolve'
      return judgeScript(args.map(x => x.value).join(' '), st, ctx)
    }
    case 'find': {
      for (let k = 0; k < args.length; k++) {
        const v = args[k].value
        if (v === '-delete') return 'find -delete'
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(v)) {
          let end = k + 1
          while (end < args.length && !(args[end].known && [';', '+'].includes(args[end].value))) end++
          const why = judgeArgv(args.slice(k + 1, end), st, ctx, depth + 1)
          if (why) return `find ${v}: ${why}`
          k = end
        }
      }
      return null
    }
    case 'git':
      return judgeGit(args)
    case 'rsync':
      return args.some(x => /^--(delete|remove-source-files)/.test(x.value)) ? 'rsync --delete' : null
    case 'dd':
      return args.some(x => x.value.startsWith('of=')) ? 'dd' : null
    case 'tee': {
      let opts = true
      for (const x of args) {
        if (opts && x.known && x.value === '--') {
          opts = false
          continue
        }
        if (opts && x.known && x.value.startsWith('-') && x.value !== '-') continue
        const why = ctx.writeTarget(x, st, 'writing with tee to')
        if (why) return why
      }
      return null
    }
  }
  if (SHELLS.has(name)) {
    const k = args.findIndex(x => x.known && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x.value))
    if (k === -1) return null
    const script = args[k + 1]
    if (!script?.known) return `${name} -c with a script the guard cannot resolve`
    return judgeScript(script.value, clone(st), ctx)
  }
  if (WRAPPERS.has(name)) {
    if (name === 'command' && args.some(x => x.known && /^-[vV]$/.test(x.value))) return null
    return judgeArgv(afterOptions(name, args), st, ctx, depth + 1)
  }
  return null
}

function judgeGit(args) {
  let k = 0
  while (k < args.length && args[k].value.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[k].value)) k++
    k++
  }
  const sub = args[k]?.value
  const rest = args.slice(k + 1).map(x => x.value)
  const destructive =
    ['clean', 'restore', 'push', 'rm', 'mv'].includes(sub) ||
    (sub === 'reset' && rest.includes('--hard')) ||
    (sub === 'checkout' && (rest.includes('--') || rest.includes('.'))) ||
    (sub === 'stash' && !['list', 'show'].includes(rest[0])) ||
    (sub === 'branch' && rest.some(r => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(r))) ||
    (sub === 'worktree' && rest[0] === 'remove')
  return destructive ? 'a destructive git command' : null
}

function judgeScript(text, st, ctx) {
  if (ctx.depth >= MAX_DEPTH) return 'commands nested too deeply to check'
  let items
  try {
    items = parseShell(text)
  } catch (e) {
    return `a nested script the guard cannot parse (${e.message})`
  }
  ctx.depth++
  try {
    return judgeList(items, st, ctx)
  } finally {
    ctx.depth--
  }
}

/**
 * Why a Bash command is refused while an audit runs, or null. `run` is the run directory, `cwd`
 * where the command starts (null: unknown, so relative write targets are refused).
 */
export function judgeBash(command, { run, cwd = null, sub = false, home = os.homedir() }) {
  const inRun = p => p === run || p.startsWith(`${run}${path.sep}`)
  const ctx = {
    sub,
    depth: 0,
    writeTarget(t, st, what) {
      if (!t.known || t.glob) return `${what} a path the guard cannot resolve`
      if (DEV.test(t.value)) return null
      if (!path.isAbsolute(t.value) && !st.cwd) return `${what} ${t.value} from an unknown directory`
      const abs = path.resolve(st.cwd ?? '/', t.value)
      return inRun(abs) ? null : `${what} ${t.value}, outside the run directory`
    },
  }
  let items
  try {
    items = parseShell(command)
  } catch (e) {
    return `the guard could not parse this command confidently (${e instanceof ShellParseError ? e.message : 'internal error'}); run it as simpler commands`
  }
  try {
    return judgeList(items, { vars: new Map(), cwd, home }, ctx)
  } catch {
    return 'the guard could not check this command; run it as simpler commands'
  }
}

export function decide(input, active) {
  if (!active) return null
  const { tool_name: tool, tool_input: args = {} } = input
  const sub = Boolean(input.agent_id)
  const run = active.run
  const cwd = input.cwd ?? null
  const resolve = p => path.resolve(cwd ?? '/', p)
  const inRun = p => {
    const r = resolve(p)
    return r === run || r.startsWith(`${run}${path.sep}`)
  }
  const inAgentArea = p => {
    const r = resolve(p)
    return new RegExp(`^${run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/agents/[a-z0-9][a-z0-9_-]{0,63}/(scratch|poc)/`).test(r)
  }
  const secret = /(^|[\s/'"=])(\.dev\.vars|\.provision\.env)\b|\.rocketflare\/config\.json/

  if (tool === 'Bash') {
    const cmd = String(args.command ?? '')
    // Credentials files are refused wherever they are named, quoted or not.
    if (secret.test(cmd)) return 'blocked during a security audit: reading a credentials file.'
    const why = judgeBash(cmd, { run, cwd, sub })
    if (!why) return null
    if (why.startsWith('redirecting') || why.startsWith('writing')) return `blocked during a security audit: ${why}.`
    return `blocked during a security audit: ${why}. Write only inside your own scratch/ and poc/; never delete or move anything.`
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = args.file_path ?? args.notebook_path ?? ''
    if (sub ? !inAgentArea(p) : !inRun(p)) {
      return `blocked during a security audit: ${tool} outside ${sub ? 'your agents/<id>/scratch or poc directory' : 'the run directory'} (${p}).`
    }
    return null
  }
  if (['Read', 'Grep', 'Glob'].includes(tool)) {
    const p = `${args.file_path ?? ''} ${args.path ?? ''} ${args.pattern ?? ''} ${args.glob ?? ''}`
    if (secret.test(p)) return 'blocked during a security audit: reading a credentials file.'
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let active = null
  try {
    active = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch {
    process.exit(0)
  }
  let input = {}
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  const reason = decide(input, active)
  if (reason) {
    process.stderr.write(`${reason}\n`)
    process.exit(2)
  }
}
