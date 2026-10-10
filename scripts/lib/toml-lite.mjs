/**
 * A small TOML reader for wrangler configs — enough of TOML 1.0 for what a wrangler toml uses:
 * tables, arrays of tables, dotted keys, basic/literal (and multi-line) strings, numbers, booleans,
 * dates (kept as strings), arrays and inline tables. Dependency-free so `kit-check.mjs` runs before
 * `pnpm install` (and so Launch can port it). Throws `TomlError` with a line number.
 */

export class TomlError extends Error {}

export function parseToml(text) {
  const root = {}
  let table = root
  let i = 0
  let line = 1
  const n = text.length

  const fail = message => {
    throw new TomlError(`line ${line}: ${message}`)
  }
  const peek = (k = 0) => text[i + k]
  const skipWs = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  }
  const skipComment = () => {
    if (text[i] === '#') while (i < n && text[i] !== '\n') i++
  }
  /** Whitespace, newlines and comments (inside arrays). */
  const skipAll = () => {
    for (;;) {
      skipWs()
      if (text[i] === '#') skipComment()
      else if (text[i] === '\n') {
        i++
        line++
      } else if (text[i] === '\r') i++
      else break
    }
  }
  const endOfLine = () => {
    skipWs()
    skipComment()
    if (i < n && text[i] === '\r') i++
    if (i < n && text[i] !== '\n') fail(`unexpected '${text[i]}'`)
  }

  const bareKey = () => {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i))
    if (!m) fail('expected a key')
    i += m[0].length
    return m[0]
  }
  const keyPart = () => {
    skipWs()
    if (peek() === '"') return basicString()
    if (peek() === "'") return literalString()
    return bareKey()
  }
  const dottedKey = () => {
    const parts = [keyPart()]
    skipWs()
    while (peek() === '.') {
      i++
      parts.push(keyPart())
      skipWs()
    }
    return parts
  }

  const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  function basicString() {
    if (text.startsWith('"""', i)) {
      i += 3
      if (text[i] === '\n') {
        i++
        line++
      }
      let out = ''
      while (!text.startsWith('"""', i)) {
        if (i >= n) fail('unterminated string')
        const ch = text[i++]
        if (ch === '\n') line++
        if (ch === '\\') {
          const e = text[i++]
          if (e === '\n') {
            line++
            while (/\s/.test(text[i] ?? '')) if (text[i++] === '\n') line++
          } else out += unescapeChar(e)
        } else out += ch
      }
      i += 3
      return out
    }
    i++
    let out = ''
    while (text[i] !== '"') {
      if (i >= n || text[i] === '\n') fail('unterminated string')
      const ch = text[i++]
      out += ch === '\\' ? unescapeChar(text[i++]) : ch
    }
    i++
    return out
  }
  function unescapeChar(e) {
    if (e in ESCAPES) return ESCAPES[e]
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8
      const hex = text.slice(i, i + len)
      i += len
      return String.fromCodePoint(Number.parseInt(hex, 16))
    }
    return fail(`bad escape \\${e}`)
  }
  function literalString() {
    if (text.startsWith("'''", i)) {
      i += 3
      if (text[i] === '\n') {
        i++
        line++
      }
      const end = text.indexOf("'''", i)
      if (end < 0) fail('unterminated string')
      const out = text.slice(i, end)
      line += out.split('\n').length - 1
      i = end + 3
      return out
    }
    i++
    const end = text.indexOf("'", i)
    if (end < 0 || text.slice(i, end).includes('\n')) fail('unterminated string')
    const out = text.slice(i, end)
    i = end + 1
    return out
  }

  function value() {
    skipWs()
    const ch = peek()
    if (ch === '"') return basicString()
    if (ch === "'") return literalString()
    if (ch === '[') {
      i++
      const arr = []
      skipAll()
      while (peek() !== ']') {
        arr.push(value())
        skipAll()
        if (peek() === ',') {
          i++
          skipAll()
        } else if (peek() !== ']') fail('expected , or ] in array')
      }
      i++
      return arr
    }
    if (ch === '{') {
      i++
      const obj = {}
      skipWs()
      if (peek() === '}') {
        i++
        return obj
      }
      for (;;) {
        const key = dottedKey()
        skipWs()
        if (peek() !== '=') fail('expected = in inline table')
        i++
        assign(obj, key, value())
        skipWs()
        if (peek() === ',') {
          i++
          continue
        }
        if (peek() === '}') {
          i++
          return obj
        }
        fail('expected , or } in inline table')
      }
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i))
    if (!m) fail('expected a value')
    i += m[0].length
    const raw = m[0]
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw))
      return Number(raw.replace(/_/g, ''))
    if (/^0x[0-9a-fA-F_]+$/.test(raw)) return Number.parseInt(raw.slice(2).replace(/_/g, ''), 16)
    if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}/.test(raw)) {
      // A date-time may carry a space before its time part.
      const rest = /^ \d{2}:\d{2}[^\s,\]}#]*/.exec(text.slice(i))
      if (rest) {
        i += rest[0].length
        return raw + rest[0]
      }
      return raw
    }
    if (['inf', '+inf', '-inf', 'nan', '+nan', '-nan'].includes(raw))
      return Number(raw.replace('inf', 'Infinity').replace('nan', 'NaN'))
    return fail(`bad value '${raw}'`)
  }

  function assign(obj, keys, v) {
    let target = obj
    for (const k of keys.slice(0, -1)) {
      if (target[k] === undefined) target[k] = {}
      if (typeof target[k] !== 'object' || Array.isArray(target[k])) fail(`key ${k} is not a table`)
      target = target[k]
    }
    const last = keys.at(-1)
    if (Object.hasOwn(target, last)) fail(`duplicate key ${keys.join('.')}`)
    target[last] = v
  }

  function openTable(keys, isArray) {
    let target = root
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1
      if (last && isArray) {
        if (target[k] === undefined) target[k] = []
        if (!Array.isArray(target[k])) fail(`${keys.join('.')} is not an array of tables`)
        const t = {}
        target[k].push(t)
        target = t
        return
      }
      if (target[k] === undefined) target[k] = {}
      const next = target[k]
      target = Array.isArray(next) ? next.at(-1) : next
      if (typeof target !== 'object' || target === null) fail(`${keys.join('.')} is not a table`)
    })
    return target
  }

  while (i < n) {
    skipAll()
    if (i >= n) break
    if (peek() === '[') {
      const isArray = peek(1) === '['
      i += isArray ? 2 : 1
      const keys = dottedKey()
      skipWs()
      if (text[i] !== ']' || (isArray && text[i + 1] !== ']')) fail('unterminated table header')
      i += isArray ? 2 : 1
      table = openTable(keys, isArray)
      endOfLine()
      continue
    }
    const keys = dottedKey()
    skipWs()
    if (peek() !== '=') fail('expected =')
    i++
    assign(table, keys, value())
    endOfLine()
  }
  return root
}
