/**
 * A small markdown renderer for UNTRUSTED input: the design documents `/rf-design` writes into
 * `docs/design/` (`scripts/design-docs.mjs`). The subset is headings, paragraphs, bold / italic,
 * inline code, fenced code, links, images, ordered and unordered lists (nested), tables,
 * blockquotes and horizontal rules. Nothing else is recognised, so raw HTML is never passed
 * through: every character of text and every attribute value is escaped on the way out, and a
 * URL reaches an attribute only through the caller's `link` / `image` hooks, which decide whether
 * it is safe.
 *
 * Pure: `renderMarkdown(src, hooks)` returns the top-level blocks as HTML strings, so a caller can
 * group them (the design pages puts each `##` section in its own panel).
 */

/** Text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const BREAK = '\u0000'

/** A heading's text with its markup removed — for ids, titles and image alt text. */
export function plainText(s) {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

/** A URL-fragment id from heading text: lower case, ASCII letters, digits and dashes. */
export function slugify(s) {
  const slug = plainText(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .trim()
    .replace(/[\s-]+/g, '-')
  return slug || 'section'
}

// ------------------------------------------------------------------- Inline

/** Index of the `]` closing the `[` at `open`, honouring nesting and escapes, else -1. */
function closingBracket(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end !== -1) i = end
    } else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** `(dest "title")` starting at `open` (the `(`): `{ dest, title, end }` or null. */
function linkTarget(s, open) {
  let i = open + 1
  while (s[i] === ' ' || s[i] === '\n') i++
  let dest = ''
  if (s[i] === '<') {
    const end = s.indexOf('>', i)
    if (end === -1) return null
    dest = s.slice(i + 1, end)
    i = end + 1
  } else {
    let depth = 0
    const start = i
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') {
        i++
        continue
      }
      if (c === ' ' || c === '\n') break
      if (c === '(') depth++
      if (c === ')') {
        if (depth === 0) break
        depth--
      }
    }
    dest = s.slice(start, i)
  }
  while (s[i] === ' ' || s[i] === '\n') i++
  let title = null
  const q = s[i]
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, i + 1)
    if (end === -1) return null
    title = s.slice(i + 1, end)
    i = end + 1
    while (s[i] === ' ' || s[i] === '\n') i++
  }
  if (s[i] !== ')') return null
  return { dest: dest.replace(/\\([!-/:-@[-`{-~])/g, '$1'), title, end: i }
}

/** Position of the delimiter run closing an emphasis opened at `from`, else -1. */
function closingDelimiter(s, from, delim) {
  const len = delim.length
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end !== -1) i = end
      continue
    }
    if (!s.startsWith(delim, i)) continue
    let run = 0
    while (s[i + run] === delim[0]) run++
    const before = s[i - 1]
    const after = s[i + run]
    const flanks = before !== undefined && !/\s/.test(before)
    const wordAfter = delim[0] === '_' && after !== undefined && /\w/.test(after)
    if (flanks && !wordAfter && (run === len || (len === 2 && run === 3) || run >= 3)) return i
    i += run - 1
  }
  return -1
}

/** One line (or paragraph) of inline markdown → HTML. */
export function renderInline(s, hooks = {}, inLink = false) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === BREAK) {
      out += '<br>\n'
      i++
      continue
    }
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
      out += escapeHtml(s[i + 1])
      i += 2
      continue
    }
    if (c === '`') {
      let run = 0
      while (s[i + run] === '`') run++
      const fence = '`'.repeat(run)
      let end = s.indexOf(fence, i + run)
      while (end !== -1 && s[end + run] === '`') end = s.indexOf(fence, end + run + 1)
      if (end === -1) {
        out += escapeHtml(fence)
        i += run
        continue
      }
      let code = s
        .slice(i + run, end)
        .replaceAll(BREAK, ' ')
        .replace(/\n/g, ' ')
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1)
      out += `<code>${escapeHtml(code)}</code>`
      i = end + run
      continue
    }
    if ((c === '!' && s[i + 1] === '[') || c === '[') {
      const image = c === '!'
      const open = image ? i + 1 : i
      const close = closingBracket(s, open)
      const target = close !== -1 && s[close + 1] === '(' ? linkTarget(s, close + 1) : null
      if (target) {
        const label = s.slice(open + 1, close)
        if (image) {
          const html = hooks.image?.(target.dest, plainText(label), target.title, false)
          out += html ?? escapeHtml(plainText(label))
        } else {
          const href = inLink ? null : hooks.link?.(target.dest)
          const inner = renderInline(label, hooks, true)
          out +=
            href == null
              ? inner
              : `<a href="${escapeHtml(href)}"${target.title ? ` title="${escapeHtml(target.title)}"` : ''}${/^https?:/i.test(href) ? ' rel="noreferrer"' : ''}>${inner}</a>`
        }
        i = target.end + 1
        continue
      }
      out += escapeHtml(s.slice(i, open + 1))
      i = open + 1
      continue
    }
    if (c === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i))
      const href = auto && !inLink ? hooks.link?.(auto[1]) : null
      if (auto && href != null) {
        out += `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(auto[1])}</a>`
        i += auto[0].length
        continue
      }
    }
    if (c === '*' || c === '_') {
      let run = 0
      while (s[i + run] === c) run++
      const prev = s[i - 1]
      const next = s[i + run]
      const opens =
        next !== undefined &&
        !/\s/.test(next) &&
        !(c === '_' && prev !== undefined && /\w/.test(prev))
      let emitted = false
      if (opens) {
        for (const len of run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1]) {
          const delim = c.repeat(len)
          const end = closingDelimiter(s, i + len, delim)
          if (end > i + len) {
            const inner = renderInline(s.slice(i + len, end), hooks, inLink)
            out +=
              len === 3
                ? `<strong><em>${inner}</em></strong>`
                : len === 2
                  ? `<strong>${inner}</strong>`
                  : `<em>${inner}</em>`
            i = end + len
            emitted = true
            break
          }
        }
      }
      if (!emitted) {
        out += escapeHtml(c.repeat(run))
        i += run
      }
      continue
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

// ------------------------------------------------------------------- Blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

const blank = line => line.trim() === ''
const indentOf = line => /^ */.exec(line)[0].length

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (ITEM.test(line) && indentOf(line) < 4 && ITEM.exec(line)[4] !== undefined) ||
    isTableStart(line, next)
  )
}

function isTableStart(line, next) {
  return line?.includes('|') && next?.includes('-') && TABLE_SEP.test(next)
}

/** Cells of one table row, split on unescaped pipes outside code spans. */
function cells(row) {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const out = []
  let cell = ''
  let code = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|'
      i++
    } else if (c === '`') {
      code = !code
      cell += c
    } else if (c === '|' && !code) {
      out.push(cell.trim())
      cell = ''
    } else cell += c
  }
  out.push(cell.trim())
  return out
}

function paragraphText(lines) {
  return lines
    .map(l => l.replace(/^ +/, ''))
    .join('\n')
    .replace(/(?: {2,}|\\)\n/g, BREAK)
    .replace(/[ \t]+$/, '')
}

/**
 * The list starting at `lines[start]`: `{ html, end }`. Items are split by marker; an item's own
 * lines are those indented past its marker (or lazy continuations of its paragraph), rendered
 * recursively, so a nested list is just a list inside an item.
 */
function renderList(lines, start, state, hooks) {
  const first = ITEM.exec(lines[start])
  const ordered = /\d/.test(first[2])
  const baseIndent = first[1].length
  const items = []
  let loose = false
  let i = start
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || m[1].length > baseIndent + 3 || /\d/.test(m[2]) !== ordered) break
    const spaces = m[3]?.length ?? 1
    const offset = m[1].length + m[2].length + (spaces > 4 ? 1 : spaces)
    const body = [m[4] ?? '']
    let sawBlank = false
    i++
    while (i < lines.length) {
      const line = lines[i]
      if (blank(line)) {
        body.push('')
        sawBlank = true
        i++
        continue
      }
      const indent = indentOf(line)
      if (indent >= offset) body.push(line.slice(offset))
      else if (indent > m[1].length && ITEM.test(line)) body.push(line.slice(indent))
      else if (!sawBlank && !startsBlock(line, lines[i + 1]) && !blank(body.at(-1)))
        body.push(line.trim())
      else break
      sawBlank = false
      i++
    }
    let trailingBlank = false
    while (body.length && blank(body.at(-1))) {
      body.pop()
      trailingBlank = true
    }
    const sibling = i < lines.length ? ITEM.exec(lines[i]) : null
    const continues =
      sibling && sibling[1].length <= baseIndent + 3 && /\d/.test(sibling[2]) === ordered
    if (trailingBlank && continues) loose = true
    if (body.some(blank)) loose = true
    items.push(body)
  }
  const tag = ordered ? 'ol' : 'ul'
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : ''
  const html = `<${tag}${startAttr}>\n${items
    .map(body => `<li>${renderBlocks(body, state, hooks, !loose).join('\n')}</li>`)
    .join('\n')}\n</${tag}>`
  return { html, end: i }
}

/** Lines → an array of block HTML strings. `tight` renders paragraphs without `<p>` (list items). */
function renderBlocks(lines, state, hooks, tight = false) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const marker = fence[2]
      const lang = /^[\w+#.-]+/.exec(fence[3].trim())?.[0]
      const body = []
      i++
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`)
        if (close.test(lines[i])) {
          i++
          break
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${fence[1].length}}`), ''))
        i++
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      out.push(
        `<pre><code${cls}>${escapeHtml(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>`
      )
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = (heading[2] ?? '').trim()
      let id = slugify(text)
      if (state.ids.has(id)) {
        let n = 2
        while (state.ids.has(`${id}-${n}`)) n++
        id = `${id}-${n}`
      }
      state.ids.add(id)
      out.push({
        level,
        text,
        id,
        toString: () => `<h${level} id="${id}">${renderInline(text, hooks)}</h${level}>`,
      })
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && !blank(lines[i])) {
        if (QUOTE.test(lines[i])) body.push(lines[i].replace(QUOTE, ''))
        else if (!startsBlock(lines[i], lines[i + 1]) && body.length) body.push(lines[i])
        else break
        i++
      }
      out.push(`<blockquote>\n${renderBlocks(body, state, hooks).join('\n')}\n</blockquote>`)
      continue
    }
    const item = ITEM.exec(line)
    if (item && indentOf(line) < 4) {
      const list = renderList(lines, i, state, hooks)
      out.push(list.html)
      i = list.end
      continue
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map(c =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'end'
            : c.startsWith(':')
              ? 'start'
              : null
      )
      const style = k => (align[k] ? ` style="text-align: ${align[k]}"` : '')
      i += 2
      const rows = []
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        rows.push(cells(lines[i]))
        i++
      }
      const th = head.map((c, k) => `<th scope="col"${style(k)}>${renderInline(c, hooks)}</th>`)
      const tr = rows.map(
        r =>
          `<tr>${head.map((_, k) => `<td${style(k)}>${renderInline(r[k] ?? '', hooks)}</td>`).join('')}</tr>`
      )
      out.push(
        `<div class="table-wrap"><table>\n<thead><tr>${th.join('')}</tr></thead>\n<tbody>\n${tr.join('\n')}\n</tbody>\n</table></div>`
      )
      continue
    }
    const para = [line]
    i++
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i])
      i++
    }
    const text = paragraphText(para)
    const solo = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(text)
    const figure = solo ? hooks.image?.(solo[2], plainText(solo[1]), solo[3] ?? null, true) : null
    if (figure) out.push(figure)
    else out.push(tight ? renderInline(text, hooks) : `<p>${renderInline(text, hooks)}</p>`)
  }
  return out
}

/**
 * Markdown → `{ blocks, headings }`. Each block is an HTML string; a heading block is an object
 * with `{ level, text, id }` whose `String()` is its HTML, so a caller can find the title and the
 * section breaks without parsing HTML back.
 *
 * Hooks decide every URL: `link(dest)` returns the href to use or null (render the text only);
 * `image(src, alt, title, standalone)` returns the HTML for an image or null (render the alt text).
 * `standalone` is true when the image is a paragraph on its own, where a `<figure>` is valid.
 */
export function renderMarkdown(src, hooks = {}) {
  const lines = String(src)
    .replace(/\r\n?/g, '\n')
    .replaceAll(BREAK, '�')
    .split('\n')
    .map(l => l.replace(/\t/g, '    '))
  return { blocks: renderBlocks(lines, { ids: new Set() }, hooks) }
}
