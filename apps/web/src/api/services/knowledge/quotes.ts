/**
 * The verifier (D43): a candidate fact survives only when its `quote` occurs VERBATIM in the
 * passage it was read from — the check Cloudflare Agent Memory runs. "Verbatim" forgives what a
 * model cannot see or reliably reproduce and nothing else: runs of whitespace (a line break inside a
 * quoted sentence), typographic quotes (`’` for `'`), a non-breaking space, and markdown emphasis
 * markers (`**`, `` ` ``). Words, digits, case and the order of everything are compared exactly.
 *
 * Pure. Offsets are JS (UTF-16) indices into the ORIGINAL text, so a match maps straight back to
 * `[charStart, charEnd)` in `documents.content`.
 */

const SKIPPED = new Set(['*', '`'])

function fold(ch: string): string {
  switch (ch) {
    case '‘':
    case '’':
    case '‛':
    case '′':
      return "'"
    case '“':
    case '”':
    case '″':
      return '"'
    default:
      return ch
  }
}

const isSpace = (ch: string) => /\s/.test(ch)

/** The normalised text and, per normalised index, the original index it came from. */
function normaliseWithMap(text: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = []
  let pendingSpace = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (SKIPPED.has(ch)) continue
    if (isSpace(ch)) {
      if (pendingSpace === -1 && out.length > 0) pendingSpace = i
      continue
    }
    if (pendingSpace !== -1) {
      out += ' '
      map.push(pendingSpace)
      pendingSpace = -1
    }
    out += fold(ch)
    map.push(i)
  }
  return { text: out, map }
}

/** A quote as a model writes it: trimmed, with wrapping quotation marks and ellipses dropped. */
export function cleanQuote(quote: string): string {
  let out = quote.trim()
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/^["'\u201C\u2018](.*)["'\u201D\u2019]$/s, '$1')
      .replace(/^(?:\.\.\.|…)\s*/, '')
      .replace(/\s*(?:\.\.\.|…)$/, '')
      .trim()
    if (next === out) break
    out = next
  }
  return out
}

/**
 * Where `quote` occurs in `text`: `{ start, end }` in `text`'s own indices, the first occurrence;
 * null when it does not occur (or is too short to mean anything — under 3 characters).
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const needle = normaliseWithMap(cleanQuote(quote)).text
  if (needle.length < 3) return null
  const hay = normaliseWithMap(text)
  const at = hay.text.indexOf(needle)
  if (at === -1) return null
  const start = hay.map[at] as number
  const end = (hay.map[at + needle.length - 1] as number) + 1
  return { start, end }
}
