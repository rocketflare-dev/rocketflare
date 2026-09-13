/**
 * Splitting text around a search query so the matches can be rendered as `<mark>` NODES — never
 * `dangerouslySetInnerHTML`, which is how a highlighter becomes an XSS hole on text somebody
 * uploaded. Pure, so it is tested in the `config` project.
 */
export interface HighlightSegment {
  text: string
  match: boolean
}

/** Escape a user's query for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `text` split into alternating plain and matching segments, case-insensitively, on any of the
 * query's whitespace-separated terms. An empty or whitespace-only query is one plain segment, so a
 * caller never has to branch. Terms shorter than two characters are ignored: highlighting every
 * "a" marks the whole document and says nothing.
 */
export function highlightMatches(
  text: string,
  query: string | null | undefined
): HighlightSegment[] {
  const terms = (query ?? '')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1)
  if (terms.length === 0) return [{ text, match: false }]
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const segments: HighlightSegment[] = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0
    if (start > last) segments.push({ text: text.slice(last, start), match: false })
    segments.push({ text: m[0], match: true })
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false })
  return segments.length > 0 ? segments : [{ text, match: false }]
}
