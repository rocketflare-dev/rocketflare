/**
 * Text → retrievable chunks (D18). Pure: text in, texts out; knows nothing about embeddings or the
 * database. Paragraph-aware: paragraphs (blank-line separated) are packed into ~800-token windows
 * and the tail of each window (~100 tokens, cut at a word boundary) is carried into the next so a
 * sentence straddling a boundary is retrievable from either side. A paragraph larger than a window
 * is hard-split with the same overlap. Token counts are a CHARACTER estimate (4 chars/token) —
 * good enough to size windows; the vector store never needs an exact count.
 */

/** ~4 characters per token for English prose — the estimate every limit here is based on. */
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHUNK_TOKENS = 800
export const DEFAULT_OVERLAP_TOKENS = 100

export interface ChunkOptions {
  maxTokens?: number
  overlapTokens?: number
}

export interface TextChunk {
  /** Position within the document, from 0. */
  seq: number
  text: string
  tokenCount: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** The last ~`chars` characters of `text`, starting at a word boundary (never mid-word). */
export function overlapTail(text: string, chars: number): string {
  if (chars <= 0) return ''
  if (text.length <= chars) return text
  const slice = text.slice(text.length - chars)
  const space = slice.search(/\s/)
  return space === -1 ? slice : slice.slice(space).trimStart()
}

/** Hard-split one oversized paragraph into windows of `maxChars` with `overlapChars` carried over. */
function splitLong(paragraph: string, maxChars: number, overlapChars: number): string[] {
  const out: string[] = []
  const step = Math.max(1, maxChars - overlapChars)
  for (let start = 0; start < paragraph.length; start += step) {
    let end = Math.min(paragraph.length, start + maxChars)
    // Prefer a word boundary for the cut unless that would lose more than a quarter of the window.
    if (end < paragraph.length) {
      const boundary = paragraph.lastIndexOf(' ', end)
      if (boundary > start + maxChars * 0.75) end = boundary
    }
    const piece = paragraph.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= paragraph.length) break
  }
  return out
}

const join = (...parts: string[]) => parts.filter(Boolean).join('\n\n')

/**
 * Split `text` into overlapping, paragraph-aligned chunks. Empty / whitespace-only input yields
 * no chunks. Every chunk is non-empty, carries fresh text (never only the overlap) and is at most
 * `maxTokens` (estimated) unless a single word exceeds it.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = (options.maxTokens ?? DEFAULT_CHUNK_TOKENS) * CHARS_PER_TOKEN
  const overlapChars = Math.min(
    (options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS) * CHARS_PER_TOKEN,
    Math.floor(maxChars / 2)
  )
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)

  const out: string[] = []
  let carried = '' // overlap from the previous chunk, prefixed to the next
  let fresh: string[] = [] // paragraphs not yet emitted

  const flush = () => {
    if (fresh.length === 0) return
    const chunk = join(carried, ...fresh)
    out.push(chunk)
    carried = overlapTail(chunk, overlapChars)
    fresh = []
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush()
      const pieces = splitLong(paragraph, maxChars, overlapChars)
      out.push(...pieces)
      carried = overlapTail(pieces[pieces.length - 1] ?? '', overlapChars)
      continue
    }
    if (join(carried, ...fresh, paragraph).length > maxChars && fresh.length > 0) flush()
    // The overlap alone may not push a lone paragraph over the window; drop it if it would.
    if (fresh.length === 0 && join(carried, paragraph).length > maxChars) carried = ''
    fresh.push(paragraph)
  }
  flush()

  return out.map((chunk, seq) => ({ seq, text: chunk, tokenCount: estimateTokens(chunk) }))
}
