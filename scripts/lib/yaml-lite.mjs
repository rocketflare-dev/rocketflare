/**
 * A small YAML reader for GitHub Actions workflows — the block subset workflows are written in:
 * nested mappings, sequences (including `- key: value` items), block scalars (`|`, `>`, with
 * chomping indicators), quoted and plain scalars, flow sequences and simple flow mappings, and
 * comments. Anchors, tags and multi-document streams are not supported (workflows do not use
 * them). Scalars stay strings — `on`, `true` and `5` included — which is what a structural check
 * wants. Dependency-free so `kit-check.mjs` runs before `pnpm install`. Throws `YamlError`.
 */

export class YamlError extends Error {}

/** Remove a trailing ` # comment` outside quotes. */
function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1])) quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

function scalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return JSON.parse(text.replace(/\\\//g, '/'))
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) return splitFlow(text.slice(1, -1)).map(scalar)
  if (text.startsWith('{') && text.endsWith('}')) {
    const out = {}
    for (const part of splitFlow(text.slice(1, -1))) {
      const m = /^([^:]+):\s*(.*)$/.exec(part)
      if (m) out[scalar(m[1])] = scalar(m[2])
    }
    return out
  }
  if (text === '' || text === '~' || text === 'null') return null
  return text
}

/** Split a flow collection's body on top-level commas. */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#][^#]*?)\s*:(?:\s+(.*))?$/

export function parseYaml(text) {
  const raw = text.replace(/\t/g, '  ').split(/\r?\n/)
  /** @type {{ indent: number, text: string, no: number }[]} */
  const lines = []
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k]
    if (/^\s*(#.*)?$/.test(line) || line.trim() === '---') continue
    lines.push({
      indent: line.length - line.trimStart().length,
      text: line.trim(),
      no: k + 1,
      rawIndex: k,
    })
  }
  let i = 0
  const fail = message => {
    throw new YamlError(`line ${lines[Math.min(i, lines.length - 1)]?.no ?? 0}: ${message}`)
  }

  /** A block scalar: every raw line after `headerIndex` indented deeper than `parentIndent`. */
  function blockScalar(indicator, parentIndent, headerRawIndex) {
    const out = []
    let k = headerRawIndex + 1
    let indent = null
    for (; k < raw.length; k++) {
      const line = raw[k]
      if (line.trim() === '') {
        out.push('')
        continue
      }
      const ind = line.length - line.trimStart().length
      if (ind <= parentIndent) break
      indent ??= ind
      out.push(line.slice(indent))
    }
    while (i < lines.length && lines[i].rawIndex < k) i++
    while (out.length && out.at(-1) === '') out.pop()
    const folded = indicator.startsWith('>')
    let body = folded ? out.join(' ').replace(/ {2,}/g, ' ') : out.join('\n')
    if (!indicator.includes('-')) body += '\n'
    return body
  }

  function parseNode(indent) {
    if (i >= lines.length) return null
    const line = lines[i]
    if (line.indent < indent) return null
    return line.text.startsWith('- ') || line.text === '-'
      ? parseSeq(line.indent)
      : parseMap(line.indent)
  }

  function parseValue(rest, parentIndent, rawIndex) {
    const text = stripComment(rest ?? '')
    if (/^[|>][+-]?\d*$/.test(text)) return blockScalar(text, parentIndent, rawIndex)
    if (text !== '') {
      // A plain scalar may continue on deeper-indented lines.
      let value = text
      while (i < lines.length && lines[i].indent > parentIndent && !KEY_RE.test(lines[i].text)) {
        value += ` ${stripComment(lines[i].text)}`
        i++
      }
      return scalar(value)
    }
    if (i < lines.length && lines[i].indent > parentIndent) return parseNode(lines[i].indent)
    // A sequence may sit at its key's own indentation.
    if (i < lines.length && lines[i].indent === parentIndent && lines[i].text.startsWith('- ')) {
      return parseSeq(parentIndent)
    }
    return null
  }

  function parseMap(indent) {
    const out = {}
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const line = lines[i]
      const m = KEY_RE.exec(stripComment(line.text))
      if (!m) fail(`expected 'key: value', got '${line.text}'`)
      i++
      const key = scalar(m[1])
      out[key] = parseValue(m[2], indent, line.rawIndex)
    }
    if (i < lines.length && lines[i].indent > indent) fail('bad indentation')
    return out
  }

  function parseSeq(indent) {
    const out = []
    while (
      i < lines.length &&
      lines[i].indent === indent &&
      (lines[i].text.startsWith('- ') || lines[i].text === '-')
    ) {
      const line = lines[i]
      const rest = line.text === '-' ? '' : line.text.slice(2).trimStart()
      if (rest === '') {
        i++
        out.push(parseNode(indent + 1))
        continue
      }
      const itemIndent = indent + (line.text.length - rest.length)
      if (KEY_RE.test(stripComment(rest)) && !/^["'[{]/.test(rest)) {
        // `- key: value` opens a mapping whose keys sit at the item's indentation.
        lines[i] = { ...line, indent: itemIndent, text: rest }
        out.push(parseMap(itemIndent))
        continue
      }
      i++
      out.push(parseValue(rest, indent, line.rawIndex))
    }
    return out
  }

  const doc = parseNode(0)
  if (i < lines.length) fail(`unexpected '${lines[i].text}'`)
  return doc ?? {}
}
