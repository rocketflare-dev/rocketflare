/**
 * The UI lint: deterministic checks over TSX and CSS text for the visual-quality rules in
 * `.claude/rules/ui.md` ("Visual quality"). Pure — text in, findings out; no filesystem, no
 * imports — so the `pnpm design:lint` CLI (`scripts/design-lint.mjs`), the Claude Code guard
 * (`scripts/kit-guard.mjs`) and the tests all read one implementation.
 *
 * Two severities:
 *
 * - `ban` — never right. `pnpm design:lint` exits 1 on one, and the guard holds a session's Stop
 *   once while one is still present.
 * - `reflex` — usually wrong, sometimes earned. Printed as a note and asked about once; never a
 *   failure. Only the reflexes a text heuristic can see are here.
 *
 * Every finding is `{ rule, severity, file, line, message, fix }`, and `fix` names the kit token
 * or component that replaces the pattern, so a report reads as a review rather than a scolding.
 *
 * **Silencing one finding**: `// ui-allow <rule>: <reason>` (or `{/* ui-allow … *\/}` in JSX, or
 * `/* ui-allow … *\/` in CSS) on the line above it or at the end of its own line. It silences ONE
 * finding of that rule. A reason is required: an allow without one is itself a `ban`, because an
 * exception nobody explained is indistinguishable from a mistake.
 *
 * **Where raw colours live**: a custom-property declaration (`--surface-app: #f4f4f5`) is a token
 * definition and may hold any colour; `apps/web/src/shared/theme-tokens.css` is the token file and
 * is exempt from `raw-colour` altogether. Everywhere else a literal colour is a finding.
 *
 * Heuristics stay conservative: a check that cannot read a file confidently (an unbalanced JSX
 * tag stack, say) reports nothing rather than guessing. A false positive costs every later agent
 * an `ui-allow`; a miss costs one review comment.
 */

/** The rules, with what each one costs and what replaces it. */
export const UI_RULES = {
  'gradient-text': {
    severity: 'ban',
    message: 'Gradient-filled text (`background-clip: text`).',
    fix: 'Solid `--text-primary`; let size and weight carry the emphasis.',
  },
  'eyebrow-label': {
    severity: 'ban',
    message: 'A small uppercase label sitting above a heading (an eyebrow or kicker).',
    fix: 'Drop it — the heading already says it. Context goes underneath, as a `PageHeader` or `SectionPanel` description.',
  },
  'glow-shadow': {
    severity: 'ban',
    message: 'A glow: a shadow with no offset, or one coloured with a brand or state colour.',
    fix: 'Elevation is `--shadow-panel` / `--shadow-popover`: an offset and a blur, in the neutral shadow colour.',
  },
  'side-stripe': {
    severity: 'ban',
    message: 'A thick border on one side of a rounded box.',
    fix: 'A full hairline border in the tone colour (`.tone-*`, `--tone-*-border`) or a `.status-badge`.',
  },
  'emoji-icon': {
    severity: 'ban',
    message: 'An emoji or a symbol glyph used as an icon.',
    fix: 'A Heroicon (`@heroicons/react`, `currentColor`), or the word itself.',
  },
  'border-and-shadow': {
    severity: 'ban',
    message: 'A border and a shadow on the same element.',
    fix: 'Pick one elevation: `.surface-panel` (the kit declares it once, as `--shadow-panel` or a border).',
  },
  'raw-colour': {
    severity: 'ban',
    message: 'A literal colour (hex, rgb, hsl, oklch) outside a token definition.',
    fix: 'A token: `--surface-*`, `--text-*`, `--border-*`, `--tone-*`, or a DaisyUI semantic class (`bg-base-200`, `text-primary`).',
  },
  'palette-utility': {
    severity: 'ban',
    message:
      'A Tailwind palette utility (`bg-blue-50`, `text-white`), which ignores the theme and the brand.',
    fix: 'A DaisyUI semantic class (`bg-primary`, `text-primary-content`, `badge-warning`) or a kit token (`.text-muted`, `--surface-*`).',
  },
  'tiny-type': {
    severity: 'ban',
    message: 'Type under 12px.',
    fix: 'The `text-xs` step (12px) is the floor; quieten with `.text-muted` rather than size. DaisyUI `-xs` controls (`btn-xs`, `badge-xs`, `select-xs`…) are fine: `ui/index.css` lifts them to 12px.',
  },
  'hard-shadow': {
    severity: 'ban',
    message: 'A hard offset shadow (an offset with no blur).',
    fix: '`--shadow-panel` / `--shadow-popover`, or no shadow at all.',
  },
  'nested-card': {
    severity: 'ban',
    message: 'A card inside a card.',
    fix: 'Inside a `SectionPanel`, group with spacing, a divider (`--border-subtle`) or `.surface-inset`.',
  },
  'decorative-background': {
    severity: 'ban',
    message: 'A decorative stripe, dot or grid background.',
    fix: 'A flat `--surface-app` / `--surface-panel`; structure comes from layout, not texture.',
  },
  'ui-allow': {
    severity: 'ban',
    message: 'A `ui-allow` without a known rule and a reason.',
    fix: 'Write `ui-allow <rule>: <why this case earns the exception>`, or remove the comment.',
  },
  'identical-card-grid': {
    severity: 'reflex',
    message: 'A grid of identical icon cards.',
    fix: 'Usually a list, a table or the nav says it better. Does the brief earn the grid?',
  },
  'hero-metric': {
    severity: 'reflex',
    message: 'A display-size number standing alone (the hero-metric layout).',
    fix: 'Put the number inside the work area it describes, at body or heading size. Does the brief earn the hero?',
  },
  'decorative-chart': {
    severity: 'reflex',
    message: 'A ring or sparkline standing in for content.',
    fix: '`RunsChart` / `TrendLine` only beside the number they explain. Does the brief earn the chart?',
  },
  'decorative-mono': {
    severity: 'reflex',
    message: 'Uppercase monospace used as decoration.',
    fix: 'Mono is for code, ids and aligned numbers; a label is `--font-sans` at `text-xs`, `.text-muted`.',
  },
  'reflex-modal': {
    severity: 'reflex',
    message: 'A form of three or more fields in a modal.',
    fix: 'A surface somebody fills in or acts on is usually a page (`.claude/rules/ui.md` "Conventions"). Does the brief earn the modal?',
  },
  'section-numbers': {
    severity: 'reflex',
    message: 'A numbered section heading ("01", "1.", "§").',
    fix: 'Headings that say what the section is; order comes from the layout. Does the brief earn the numbers?',
  },
}

export const RULE_IDS = Object.keys(UI_RULES)

/** The token file, where raw colours are the point. */
export const TOKEN_FILES = ['apps/web/src/shared/theme-tokens.css']

const UI_DIRS = [/^apps\/web\/src\/ui\//, /^apps\/web\/src\/plugins\/[^/]+\/ui\//]
const UI_EXT = /\.(tsx|ts|jsx|css)$/

/** `true` for a repository-relative path the UI lint reads. */
export function isUiPath(rel) {
  if (typeof rel !== 'string') return false
  const p = rel.replaceAll('\\', '/')
  return UI_EXT.test(p) && !/\.d\.ts$/.test(p) && UI_DIRS.some(re => re.test(p))
}

const finding = (rule, file, line, detail) => ({
  rule,
  severity: UI_RULES[rule].severity,
  file,
  line,
  message: detail ? `${UI_RULES[rule].message} ${detail}` : UI_RULES[rule].message,
  fix: UI_RULES[rule].fix,
})

// ------------------------------------------------------------------ text helpers

/**
 * The text with every comment blanked to spaces (newlines kept, so line numbers survive).
 * String and template literals are respected so `'https://…'` is not a comment; a single- or
 * double-quoted string ends at a newline, which bounds the damage an apostrophe in JSX text does.
 */
export function blankComments(text, { css = false } = {}) {
  let out = ''
  let i = 0
  const n = text.length
  const blank = s => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += blank(text.slice(i, stop))
      i = stop
    } else if (!css && c === '/' && d === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(text.slice(i, stop))
      i = stop
    } else if (c === '"' || c === "'" || (!css && c === '`')) {
      let j = i + 1
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++
        else if (c !== '`' && text[j] === '\n') break
        j++
      }
      out += text.slice(i, Math.min(j + 1, n))
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

const lineAt = (text, index) => {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** Every string or template literal on each line: `[{ line, text }]`. */
function literals(code) {
  const found = []
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    found.push({ line: lineAt(code, m.index), text: m[1] ?? m[2] ?? m[3] ?? '' })
  }
  return found
}

// ------------------------------------------------------------------ shadows

const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)?$/
const lengthPx = token => {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)?$/.exec(token)
  if (!m) return null
  const v = Number(m[1])
  return m[2] === 'rem' || m[2] === 'em' ? v * 16 : v
}

/** Split on commas outside parentheses. */
const splitTop = value => {
  const parts = []
  let depth = 0
  let buf = ''
  for (const c of value) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
    } else buf += c
  }
  parts.push(buf)
  return parts.map(s => s.trim()).filter(Boolean)
}

/**
 * The problems with one `box-shadow` value: `'glow'` (no offset, a blur), `'hard'` (an offset,
 * no blur), or none. A spread-only `0 0 0 2px` ring is neither: it is a focus ring.
 */
export function shadowProblems(value) {
  const problems = new Set()
  if (typeof value !== 'string' || /^\s*(none|initial|unset|inherit)\s*$/i.test(value)) return []
  for (const layer of splitTop(value)) {
    const stripped = layer
      .replace(
        /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix|var)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi,
        ' '
      )
      .replace(/#[0-9a-f]{3,8}\b/gi, ' ')
      .replace(/\binset\b/gi, ' ')
    const lengths = stripped
      .split(/\s+/)
      .filter(t => LENGTH.test(t))
      .map(lengthPx)
    if (lengths.length < 2) continue
    const [x, y, blur = 0] = lengths
    if (x === 0 && y === 0 && blur > 0) problems.add('glow')
    if ((x !== 0 || y !== 0) && blur === 0) problems.add('hard')
  }
  return [...problems]
}

// ------------------------------------------------------------------ colours

const COLOUR_FN = /\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch)\(\s*[\d.]/i
const HEX = /(^|[\s"'`(:,[=])#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?=$|[\s"'`),;\]/!}])/
const hasRawColour = text => COLOUR_FN.test(text) || HEX.test(text)

// ------------------------------------------------------------------ Tailwind tokens

const V = String.raw`(?<![\w-])(?:[a-z0-9-]+:|\[[^\]]+\]:)*!?`
const END = String.raw`(?![\w-])`
const PALETTE = new RegExp(
  `${V}(?:bg|text|border(?:-[trblxyse])?|from|via|to|ring|ring-offset|fill|stroke|outline|divide|shadow|decoration|accent|caret|placeholder)-` +
    `(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\\/\\d+)?${END}`
)
const BORDER = new RegExp(`${V}border(?:-[trblxyse])?(?:-(?:[1-9]\\d*|\\[[^\\]]*px\\]))?${END}`)
const SHADOW = new RegExp(
  `${V}shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|\\[[^\\]]+\\]|\\([^)]+\\)))?${END}`
)
const COLOURED_SHADOW = new RegExp(
  `${V}shadow-(?:primary|secondary|accent|info|success|warning|error|neutral|base-content)(?:\\/\\d+)?${END}`
)
const ARBITRARY_SHADOW = /(?<![\w-])(?:[a-z0-9-]+:)*(?:drop-)?shadow-\[([^\]]+)\]/g
const SIDE_STRIPE = new RegExp(`${V}border-[lrse]-(?:[2-9]|\\[(?:[2-9]|\\d{2,})px\\])${END}`)
const ROUNDED = new RegExp(`${V}(?:rounded(?!-none)(?:-[a-z0-9]+)?|card|alert|surface-panel)${END}`)
/** The type floor (`text-xs`). DaisyUI's `-xs` sizes are under it, so `ui/index.css` lifts them. */
const TINY_PX = 12
const TINY_ARBITRARY = /(?<![\w-])(?:[a-z0-9-]+:)*text-\[(\d*\.?\d+)(px|rem|em)\]/g
const CARD_CLASS = /(?<![\w-])(?:card|surface-panel)(?![\w-])/
const CARD_COMPONENTS = new Set(['SectionPanel'])

/** The px size of a CSS font-size value, or null when it is relative or unreadable. */
const fontPx = value => {
  const m = /^\s*(\d*\.?\d+)(px|rem)\s*$/.exec(value)
  if (!m) return null
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])
}

// Emoji and the symbol glyphs that get used as icons. Excluded: (c) (R) TM and the arrows,
// which are typography in running copy ("Open →").
const EMOJI = /[\p{Extended_Pictographic}✓✔✕✖✗✘★☆]/u
const NOT_ICON = /[©®™←-⇿]/u
const hasIconGlyph = text => {
  for (const ch of text) if (EMOJI.test(ch) && !NOT_ICON.test(ch)) return true
  return false
}

// ------------------------------------------------------------------ allow comments

const ALLOW = /ui-allow(?:\s+([a-z][a-z-]*))?(?:\s*:\s*([^*\n]*?))?\s*(?:\*\/\s*\}?)?\s*$/

/** Every `ui-allow` comment: `{ line, rule, reason }`. */
export function allowComments(text) {
  const allows = []
  text.split('\n').forEach((raw, index) => {
    const at = raw.search(/(?:\/\/|\/\*)\s*ui-allow\b/)
    if (at === -1) return
    const m = ALLOW.exec(raw.slice(at).replace(/^(?:\/\/|\/\*)\s*/, ''))
    allows.push({ line: index + 1, rule: m?.[1] ?? null, reason: (m?.[2] ?? '').trim() })
  })
  return allows
}

/**
 * Drop each finding an allow covers (same line or the line below the comment), one finding per
 * allow, and add a `ui-allow` finding for every allow with no known rule or no reason.
 */
function applyAllows(findings, text, file) {
  const allows = allowComments(text)
  const out = []
  const problems = []
  for (const allow of allows) {
    if (!allow.rule || !UI_RULES[allow.rule] || allow.rule === 'ui-allow') {
      problems.push(finding('ui-allow', file, allow.line, `Unknown rule \`${allow.rule ?? ''}\`.`))
      allow.used = true
    } else if (!allow.reason) {
      problems.push(finding('ui-allow', file, allow.line, `\`${allow.rule}\` has no reason.`))
      allow.used = true
    }
  }
  for (const f of findings) {
    const allow = allows.find(
      a => !a.used && a.rule === f.rule && (a.line === f.line || a.line + 1 === f.line)
    )
    if (allow) allow.used = true
    else out.push(f)
  }
  return [...out, ...problems]
}

// ------------------------------------------------------------------ TSX

/** Class-string checks, per literal. */
function literalFindings(code, file) {
  const out = []
  for (const { line, text } of literals(code)) {
    if (PALETTE.test(text))
      out.push(finding('palette-utility', file, line, `\`${PALETTE.exec(text)[0]}\``))
    if (/(?<![\w-])(?:[a-z0-9-]+:)*bg-clip-text(?![\w-])/.test(text)) {
      out.push(finding('gradient-text', file, line))
    }
    if (COLOURED_SHADOW.test(text))
      out.push(finding('glow-shadow', file, line, `\`${COLOURED_SHADOW.exec(text)[0]}\``))
    for (const m of text.matchAll(ARBITRARY_SHADOW)) {
      const problems = shadowProblems(m[1].replaceAll('_', ' '))
      if (problems.includes('glow')) out.push(finding('glow-shadow', file, line))
      if (problems.includes('hard')) out.push(finding('hard-shadow', file, line))
    }
    const bordered = text
      .split(/\s+/)
      .some(t => BORDER.test(t) && !/border-(?:0|none|transparent)$/.test(t))
    const shadowed = text.split(/\s+/).some(t => SHADOW.test(t) && !/shadow-none$/.test(t))
    if (bordered && shadowed) out.push(finding('border-and-shadow', file, line))
    if (SIDE_STRIPE.test(text) && ROUNDED.test(text)) out.push(finding('side-stripe', file, line))
    for (const m of text.matchAll(TINY_ARBITRARY)) {
      const px = m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16
      if (px < TINY_PX) out.push(finding('tiny-type', file, line, `\`${m[0]}\``))
    }
    if (/(?<![\w-])font-mono(?![\w-])/.test(text) && /(?<![\w-])uppercase(?![\w-])/.test(text)) {
      out.push(finding('decorative-mono', file, line))
    }
    if (/(?<![\w-])radial-progress(?![\w-])/.test(text))
      out.push(finding('decorative-chart', file, line))
    if (
      /(?<![\w-])bg-\[(?:repeating-|url\()/.test(text) ||
      /(?<![\w-])bg-(?:grid|dots?|stripes?)(?:-[a-z0-9]+)?(?![\w-])/.test(text) ||
      (/bg-\[(?:linear|radial)-gradient/.test(text) &&
        /\[background-size:|bg-\[size:|bg-size-/.test(text))
    ) {
      out.push(finding('decorative-background', file, line))
    }
  }
  return out
}

/** Line-level checks over the comment-blanked code. */
function lineFindings(code, file) {
  const out = []
  const lines = code.split('\n')
  lines.forEach((text, index) => {
    const line = index + 1
    if (hasRawColour(text)) out.push(finding('raw-colour', file, line))
    if (hasIconGlyph(text)) out.push(finding('emoji-icon', file, line))
    if (/WebkitBackgroundClip\s*:\s*['"]text['"]|backgroundClip\s*:\s*['"]text['"]/.test(text)) {
      out.push(finding('gradient-text', file, line))
    }
    for (const m of text.matchAll(/boxShadow\s*:\s*(['"`])([^'"`]+)\1/g)) {
      const problems = shadowProblems(m[2])
      if (problems.includes('glow')) out.push(finding('glow-shadow', file, line))
      if (problems.includes('hard')) out.push(finding('hard-shadow', file, line))
    }
    for (const m of text.matchAll(/fontSize\s*[:=]\s*\{?\s*(['"]?)(\d*\.?\d+)(px|rem)?\1/g)) {
      const px = m[3] === 'rem' ? Number(m[2]) * 16 : Number(m[2])
      if (px < TINY_PX) out.push(finding('tiny-type', file, line, `\`${m[0].trim()}\``))
    }
    if (/<(?:Sparkline|Donut\w*|Gauge\w*|Ring(?:Chart)?)\b/.test(text)) {
      out.push(finding('decorative-chart', file, line))
    }
    // A display-size number: text-4xl and up on something that is not a heading.
    const hero = /<([a-z]+)\b[^>]*className=[^>]*(?<![\w-])text-(?:[4-9])xl(?![\w-])/.exec(text)
    // …and only when what it shows reads as a number (a name or a tagline at that size is type).
    const shown = hero
      ? (lines
          .slice(index, index + 3)
          .join(' ')
          .split(/>(.*)/s)[1] ?? '')
      : ''
    const numeric =
      /^\s*[-+]?[$€£]?\d/.test(shown) ||
      /^\s*\{[^}]*(?:count|total|sum|toLocaleString|format\w*|\.length|percent|[Nn]umber)\b/.test(
        shown
      ) ||
      /(?<![\w-])tabular-nums(?![\w-])/.test(text)
    if (hero && numeric && !/^h[1-6]$/.test(hero[1])) out.push(finding('hero-metric', file, line))
    if (/<h[1-6]\b[^>]*>\s*(?:0\d\b|\d{1,2}\.\s|§\s?\d)/.test(text)) {
      out.push(finding('section-numbers', file, line))
    }
  })
  return out
}

const KICKER = /(?<![\w-])uppercase(?![\w-])/
const KICKER_SMALL = /(?<![\w-])(?:tracking-[a-z]+|text-xs|text-\[)/

/** An uppercase small label whose next element is a heading. */
function eyebrowFindings(code, file) {
  const out = []
  const lines = code.split('\n')
  lines.forEach((text, index) => {
    const tag = /<([a-z][a-z0-9]*)\b[^>]*className=(["'`{])/.exec(text)
    if (!tag || /^(?:h[1-6]|th|legend|label|dt|summary|button|option)$/.test(tag[1])) return
    if (!KICKER.test(text) || !KICKER_SMALL.test(text)) return
    // The label's own element closes on this line, or the next one or two.
    let j = index
    while (j < lines.length && j < index + 3 && !new RegExp(`</${tag[1]}>`).test(lines[j])) j++
    for (let k = j + 1; k < Math.min(lines.length, j + 3); k++) {
      const next = lines[k].trim()
      if (next === '') continue
      if (/^<(?:h[1-6]|PageHeader)\b/.test(next))
        out.push(finding('eyebrow-label', file, index + 1))
      break
    }
  })
  return out
}

/**
 * A grid of two or more columns whose children are mapped, each with an icon and a card
 * surface: the identical-icon-card reflex.
 */
function cardGridFindings(code, file) {
  const out = []
  const lines = code.split('\n')
  lines.forEach((text, index) => {
    if (!/(?<![\w-])(?:[a-z]+:)?grid-cols-[2-9](?![\w-])/.test(text)) return
    const mapAt = lines.slice(index, index + 8).findIndex(l => /\.map\(/.test(l))
    if (mapAt === -1) return
    const body = lines.slice(index + mapAt, index + mapAt + 25).join('\n')
    const icon = /<[A-Z]\w*Icon\b|\bIcon\b|icon=\{|<\w+\.icon\b/.test(body)
    const card =
      CARD_CLASS.test(body) ||
      /(?<![\w-])surface-inset(?![\w-])/.test(body) ||
      /<SectionPanel\b/.test(body) ||
      /(?<![\w-])border(?![\w-])[^"'`]*rounded|rounded[^"'`]*(?<![\w-])border(?![\w-])/.test(body)
    if (icon && card) out.push(finding('identical-card-grid', file, index + 1))
  })
  return out
}

/** A `<Modal>` whose body holds three or more form fields. */
function modalFindings(code, file) {
  const out = []
  const re = /<Modal\b/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const end = code.indexOf('</Modal>', m.index)
    if (end === -1) continue
    const body = code.slice(m.index, end)
    const fields = body.match(/<(?:input|select|textarea|Input|Select|Textarea|TextField)\b/g) ?? []
    if (fields.length >= 3) out.push(finding('reflex-modal', file, lineAt(code, m.index)))
  }
  return out
}

/** The tag that starts at `i` (`<Name` or `</Name` or `<>`), or null. */
function readTag(code, i) {
  const m = /^<(\/?)([A-Za-z][\w.]*)?/.exec(code.slice(i, i + 80))
  if (!m) return null
  const closing = m[1] === '/'
  const name = m[2] ?? ''
  let j = i + m[0].length
  if (!closing && name === '' && code[j] !== '>') return null
  let depth = 0
  let quote = null
  for (; j < code.length; j++) {
    const c = code[j]
    if (quote) {
      if (c === '\\') j++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) break
  }
  if (j >= code.length) return null
  const raw = code.slice(i, j + 1)
  return { closing, name, raw, end: j + 1, selfClosing: /\/\s*>$/.test(raw) }
}

/**
 * A card-like element (`SectionPanel`, or a `card` / `surface-panel` class) opened inside
 * another. A tag stack over the JSX; anything it cannot balance makes it report nothing.
 */
function nestedCardFindings(code, file) {
  const out = []
  const stack = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '<') continue
    const before = code.slice(Math.max(0, i - 12), i)
    // A generic (`useState<T>`) or a comparison (`a < b`) is not JSX.
    if (code[i + 1] !== '/' && /[\w)\]]\s*$/.test(before) && !/\breturn\s*$/.test(before)) continue
    if (/^<\s/.test(code.slice(i, i + 2))) continue
    const tag = readTag(code, i)
    if (!tag) continue
    i = tag.end - 1
    if (tag.closing) {
      const at = stack.map(s => s.name).lastIndexOf(tag.name)
      if (at === -1) return []
      stack.length = at
      continue
    }
    if (tag.selfClosing) continue
    const className = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/.exec(tag.raw)
    const card =
      CARD_COMPONENTS.has(tag.name) ||
      CARD_CLASS.test(className ? (className[1] ?? className[2] ?? className[3] ?? '') : '')
    if (card && stack.some(s => s.card)) out.push(finding('nested-card', file, lineAt(code, i)))
    stack.push({ name: tag.name, card })
  }
  return out
}

/** Every finding in one TSX/TS/JSX file. */
export function lintTsx(text, file = '') {
  const code = blankComments(text)
  const found = [
    ...literalFindings(code, file),
    ...lineFindings(code, file),
    ...eyebrowFindings(code, file),
    ...cardGridFindings(code, file),
    ...modalFindings(code, file),
    ...(/\.(tsx|jsx)$/.test(file) || file === '' ? nestedCardFindings(code, file) : []),
  ]
  return sortFindings(applyAllows(dedupe(found), text, file))
}

// ------------------------------------------------------------------ CSS

/**
 * The rule blocks of a stylesheet: `[{ prelude, line, decls: [{ prop, value, line }] }]`, at
 * every nesting depth (`@layer`, `@media`). Comments must already be blanked.
 */
export function cssBlocks(code) {
  const blocks = []
  const stack = [{ prelude: '', line: 1, decls: [] }]
  let buf = ''
  let bufStart = 0
  let quote = null
  const push = end => {
    const text = buf.trim()
    const m = /^(--[\w-]+|-?[a-z][\w-]*)\s*:\s*([\s\S]*)$/i.exec(text)
    if (m) {
      const offset = bufStart + buf.indexOf(text)
      stack[stack.length - 1].decls.push({
        prop: m[1].toLowerCase(),
        value: m[2].trim(),
        line: lineAt(code, offset),
      })
    }
    buf = ''
    bufStart = end
  }
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      buf += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      buf += c
    } else if (c === '{') {
      const prelude = buf.trim()
      stack.push({ prelude, line: lineAt(code, bufStart + buf.indexOf(prelude)), decls: [] })
      buf = ''
      bufStart = i + 1
    } else if (c === ';') {
      push(i + 1)
    } else if (c === '}') {
      push(i + 1)
      if (stack.length > 1) blocks.push(stack.pop())
    } else {
      if (buf === '') bufStart = i
      buf += c
    }
  }
  return blocks
}

const isNone = v => /^\s*(?:none|0|0px|transparent)\b/i.test(v)

/** Every finding in one stylesheet. */
export function lintCss(text, file = '') {
  const code = blankComments(text, { css: true })
  const tokenFile = TOKEN_FILES.some(t => file === t || file.endsWith(`/${t}`))
  const out = []
  for (const block of cssBlocks(code)) {
    const get = prop => block.decls.filter(d => d.prop === prop)
    for (const d of block.decls) {
      const custom = d.prop.startsWith('--')
      if (!custom && !tokenFile && hasRawColour(d.value))
        out.push(finding('raw-colour', file, d.line))
      if (/^(?:-webkit-)?background-clip$/.test(d.prop) && /\btext\b/.test(d.value)) {
        out.push(finding('gradient-text', file, d.line))
      }
      if (d.prop === 'box-shadow' || /^--shadow-/.test(d.prop)) {
        const problems = shadowProblems(d.value)
        if (problems.includes('glow')) out.push(finding('glow-shadow', file, d.line))
        if (problems.includes('hard')) out.push(finding('hard-shadow', file, d.line))
      }
      if (d.prop === 'font-size') {
        const px = fontPx(d.value)
        if (px !== null && px < TINY_PX)
          out.push(finding('tiny-type', file, d.line, `\`${d.value}\``))
      }
      if (
        /^background(?:-image)?$/.test(d.prop) &&
        /repeating-(?:linear|radial|conic)-gradient/.test(d.value)
      ) {
        out.push(finding('decorative-background', file, d.line))
      }
    }
    const borders = block.decls.filter(d => /^border(?:-width)?$/.test(d.prop) && !isNone(d.value))
    const shadows = get('box-shadow').filter(d => !isNone(d.value))
    if (borders.length > 0 && shadows.length > 0) {
      out.push(finding('border-and-shadow', file, shadows[0].line))
    }
    const stripe = block.decls.find(d => {
      if (!/^border-(?:left|right|inline-start|inline-end)(?:-width)?$/.test(d.prop)) return false
      const px = lengthPx(d.value.split(/\s+/).find(t => LENGTH.test(t)) ?? '')
      return px !== null && px >= 2
    })
    const rounded = get('border-radius').some(d => !isNone(d.value))
    if (stripe && rounded) out.push(finding('side-stripe', file, stripe.line))
    const gradient = block.decls.find(
      d =>
        /^background(?:-image)?$/.test(d.prop) && /(?:linear|radial|conic)-gradient/.test(d.value)
    )
    const tiled = get('background-size').some(
      d => /\d/.test(d.value) && !/\b(?:cover|contain|100%)/.test(d.value)
    )
    if (gradient && tiled) out.push(finding('decorative-background', file, gradient.line))
    const mono = get('font-family').some(d => /--font-mono|monospace/.test(d.value))
    const upper = get('text-transform').some(d => /uppercase/.test(d.value))
    if (mono && upper) out.push(finding('decorative-mono', file, block.line))
  }
  return sortFindings(applyAllows(dedupe(out), text, file))
}

// ------------------------------------------------------------------ shared

function dedupe(findings) {
  const seen = new Set()
  return findings.filter(f => {
    const key = `${f.rule}:${f.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const sortFindings = findings =>
  [...findings].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))

/** Every finding in one file, by its extension. */
export function lintSource(text, file) {
  if (typeof text !== 'string') return []
  return /\.css$/.test(file) ? lintCss(text, file) : lintTsx(text, file)
}

/** `{ bans, reflexes }` of a finding list. */
export function splitFindings(findings) {
  return {
    bans: findings.filter(f => f.severity === 'ban'),
    reflexes: findings.filter(f => f.severity === 'reflex'),
  }
}

/** One finding as one line of a report: `file:line  rule  message → fix`. */
export function formatFinding(f) {
  return `${f.file}:${f.line}  ${f.rule}  ${f.message} Fix: ${f.fix}`
}
