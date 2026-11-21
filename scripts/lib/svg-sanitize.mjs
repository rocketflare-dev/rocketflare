/**
 * An SVG diagram made safe to inline into a page: the design pages inlines
 * `docs/design/diagrams/*.svg` (rather than linking it) so the drawing can use the page's CSS
 * custom properties and token classes. The file is UNTRUSTED, so it is re-serialised from a
 * parse rather than filtered as text: only allow-listed elements survive (no `<script>`,
 * `<style>`, `<foreignObject>`, `<image>`, animation or `<iframe>`), every `on*` attribute is
 * dropped, an `href` may only point inside the drawing (`#id`), any attribute value carrying
 * `javascript:` (or `url()` to anything but `#id`) is dropped, and text is escaped again.
 *
 * Ids are prefixed per diagram, references included, so two diagrams on one page cannot collide.
 */
import { escapeHtml } from './markdown-lite.mjs'

const ELEMENTS = new Set(
  [
    'svg',
    'g',
    'defs',
    'symbol',
    'use',
    'title',
    'desc',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textPath',
    'marker',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
    'filter',
    'feGaussianBlur',
    'feOffset',
    'feBlend',
    'feFlood',
    'feComposite',
    'feMerge',
    'feMergeNode',
    'feColorMatrix',
    'feDropShadow',
  ].map(e => e.toLowerCase())
)
/** Elements whose tag goes but whose children stay (a link's text, say). */
const UNWRAP = new Set(['a', 'switch'])

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[\s\S]*?(?:\?>|$)|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

/** Text as the XML it came from: known entities kept, everything else escaped. */
function text(s) {
  return s
    .replace(/&(?!(?:[a-zA-Z]{2,8}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `s` without whitespace or control characters (U+0000 to U+0020, U+007F), which a browser ignores in a URL scheme. */
const withoutControls = s =>
  [...s].filter(ch => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) !== 127).join('')

/** A value with entities decoded enough to see a disguised scheme (`&#106;avascript:`). */
function decoded(value) {
  return withoutControls(
    value
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 32))
      .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32))
      .replace(/&colon;/gi, ':')
      .replace(/&tab;|&newline;/gi, '')
  )
}

function attributes(raw, prefix) {
  const out = []
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1]
    const lower = name.toLowerCase()
    let value = m[2] ?? m[3] ?? m[4] ?? ''
    if (!/^[A-Za-z_][\w:.-]*$/.test(name) || lower.startsWith('on')) continue
    if (lower === 'xmlns' || lower.startsWith('xmlns:')) {
      out.push(`${name}="${escapeHtml(value)}"`)
      continue
    }
    const plain = decoded(value).toLowerCase()
    if (/javascript:|vbscript:|data:/.test(plain)) continue
    if (lower === 'href' || lower.endsWith(':href') || lower === 'src') {
      if (!/^#[\w.-]+$/.test(value)) continue
      value = `#${prefix}${value.slice(1)}`
    }
    if (/url\(/.test(plain)) {
      const refs = [...value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)]
      if (refs.some(r => !/^#[\w.-]+$/.test(r[2]))) continue
      value = value.replace(/url\(\s*(['"]?)#([\w.-]+)\1\s*\)/gi, `url(#${prefix}$2)`)
    }
    if (lower === 'style' && /expression|@import|behavior|binding/.test(plain)) continue
    if (lower === 'id') value = `${prefix}${value}`
    out.push(`${name}="${escapeHtml(value)}"`)
  }
  return out
}

/**
 * The sanitised `<svg>…</svg>`, with `role="img"` and an `aria-label` from `label`; null when the
 * input has no `<svg>` root. `idPrefix` (letters, digits, dashes) namespaces the drawing's ids.
 */
export function sanitizeSvg(source, { idPrefix = 'd-', label = '' } = {}) {
  const src = String(source)
  const prefix = idPrefix.replace(/[^\w-]/g, '')
  const stack = []
  let skip = 0
  let out = ''
  let last = 0
  let sawRoot = false
  let done = false
  for (const m of src.matchAll(TOKEN)) {
    if (done) break
    const between = src.slice(last, m.index)
    last = m.index + m[0].length
    if (!skip && stack.length) out += text(between)
    const [whole, closeName, openName, rawAttrs, selfClose] = m
    if (closeName) {
      const name = closeName.toLowerCase()
      if (skip) {
        if (stack.at(-1)?.name === name) {
          stack.pop()
          skip--
        }
        continue
      }
      const at = stack.map(e => e.name).lastIndexOf(name)
      if (at === -1) continue
      while (stack.length > at) {
        const el = stack.pop()
        if (el.emit) out += `</${el.tag}>`
      }
      if (stack.length === 0 && sawRoot) done = true
      continue
    }
    if (!openName) continue // comment, CDATA, doctype, processing instruction
    const name = openName.toLowerCase()
    const self = selfClose === '/' || whole.endsWith('/>')
    if (skip) {
      if (!self) {
        stack.push({ name, emit: false })
        skip++
      }
      continue
    }
    if (!sawRoot) {
      if (name !== 'svg') continue
      sawRoot = true
    }
    if (UNWRAP.has(name)) {
      if (!self) stack.push({ name, emit: false })
      continue
    }
    if (!ELEMENTS.has(name)) {
      if (!self) {
        stack.push({ name, emit: false })
        skip++
      }
      continue
    }
    let attrs = attributes(rawAttrs ?? '', prefix)
    if (name === 'svg' && stack.length === 0) {
      attrs = attrs.filter(a => !/^(role|aria-label|aria-labelledby|aria-hidden)=/i.test(a))
      attrs.push('role="img"')
      if (label) attrs.push(`aria-label="${escapeHtml(label)}"`)
    }
    const tag = openName
    const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`
    if (self) out += `${open}/>`
    else {
      out += `${open}>`
      stack.push({ name, tag, emit: true })
    }
  }
  if (!sawRoot) return null
  while (stack.length) {
    const el = stack.pop()
    if (el.emit) out += `</${el.tag}>`
  }
  return out.trim()
}
