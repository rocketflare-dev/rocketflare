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
 * Words too common to be worth marking. Highlighting only: whether a query is too common to SEARCH
 * is the server's call (`lexical: 'no_terms'`), so this list never decides what is found — it
 * stops "the" lighting up in every line of a passage the query's real words found.
 */
const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by can do does did for from had has have how i if in into is ' +
    'it its me my no not of on or our so than that the their them then there these they this to ' +
    'us was we were what when where which who why will with you your'
  ).split(' ')
)

/** The query's words worth marking: two characters or more, not a stop-word, each once. */
export function highlightTerms(query: string | null | undefined): string[] {
  const terms = (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    // Punctuation round a word is not part of it ("shipment?" is "shipment"); "$5" keeps its "$".
    .map(t => t.replace(/^[.,;:!?()[\]{}"“”'‘’]+|[.,;:!?()[\]{}"“”'‘’]+$/g, ''))
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
  return [...new Set(terms)]
}

/**
 * `text` split into alternating plain and matching segments, case-insensitively, on WHOLE words of
 * the query (`highlightTerms`) — "the" never marks inside "whether", and a stop-word never marks at
 * all. An empty query, or one of nothing but stop-words, is one plain segment, so a caller never
 * has to branch.
 */
export function highlightMatches(
  text: string,
  query: string | null | undefined
): HighlightSegment[] {
  const terms = highlightTerms(query)
  if (terms.length === 0) return [{ text, match: false }]
  // Longest first, so "ship" never wins over "shipment" when both are terms.
  const alternatives = terms
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu')
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

/**
 * Whether a plain-text document is really markdown — pasted text usually is, and showing its
 * `#` and `| --- |` raw reads as broken. Two or more structural lines (a heading, a table rule, a
 * list item, a fence) are the signal; one stray `-` line is not.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.slice(0, 20_000).split('\n')
  let signals = 0
  for (const line of lines) {
    if (/^\s{0,3}(#{1,6}\s|```|>\s|[-*+]\s|\d+[.)]\s|\|.*\|\s*$)/.test(line)) signals += 1
    if (signals >= 2) return true
  }
  return false
}

/**
 * A passage as a reader sees it, without its markdown syntax — for a search snippet, which shows
 * a few lines of a passage as text, where `## Who signs` and `| --- |` are noise. Line breaks stay
 * (the snippet is `whitespace-pre-line`); table rules go; cells read as "a · b".
 */
export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line))
    .map(line => {
      let out = line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '• ')
        .replace(/^\s*```.*$/, '')
      // A table row — or the tail of one, where a passage starts mid-table.
      if (/^\s*\|/.test(out) || /\|\s*$/.test(out)) {
        out = out
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(cell => cell.trim())
          .filter(Boolean)
          .join(' · ')
      }
      return out
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
