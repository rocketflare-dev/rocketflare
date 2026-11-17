/**
 * Text → retrievable chunks. Pure: text in, ranges out; knows nothing about embeddings or the
 * database.
 *
 * **Every chunk is an exact slice of the text it was given**: `text === input.slice(charStart,
 * charEnd)` (JS UTF-16 offsets). Nothing is prepended to a stored chunk — the overlap between
 * neighbours comes from starting the next window EARLIER (~100 tokens back, at a word boundary),
 * so a passage can always be located in `documents.content` by its offsets alone.
 *
 * **Structure first.** Markdown ATX headings (`#`..`######` at the start of a line, outside a
 * fenced code block) are boundaries: a chunk begins and ends at one. Consecutive whole sections
 * that fit a window together are packed into one chunk (its `headingPath` is the headings they
 * share); only a section larger than a window is cut inside. Each chunk carries `headingPath`,
 * the stack of headings it sits under (`['Pricing', 'Annual plans']`; the heading
 * line belongs to the section it opens; text before the first heading has an empty path). Within
 * a section, blank-line separated paragraphs are packed into ~800-token windows; a paragraph larger
 * than a window is hard-split at word boundaries. **GFM tables** (a header row, a `|---|`
 * delimiter row, body rows — how `toMarkdown` renders every spreadsheet sheet) are blocks of their
 * own: one that fits is packed like a paragraph; an oversized one splits ONLY between rows (a
 * single row longer than a window is the one case that is hard-split), its overlap is whole rows,
 * and every chunk holding rows without the table's own header carries `tableHeader`.
 *
 * `headingPath` and `tableHeader` are context for the EMBEDDER (`embeddingInput`) and the lexical
 * index (`chunks.search_vector`), never part of the stored text. `page` is always null:
 * `AI.toMarkdown` emits no page markers to read it from (docs/CONCEPTS.md §9, Known gaps).
 *
 * Token counts are a CHARACTER estimate (4 chars/token) — good enough to size windows; the vector
 * store never needs an exact count.
 */

/** ~4 characters per token for English prose — the estimate every limit here is based on. */
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHUNK_TOKENS = 800
export const DEFAULT_OVERLAP_TOKENS = 100
/** How a heading path is joined for storage (`chunks.heading_path`) and display. */
export const HEADING_PATH_SEPARATOR = ' › '

export interface ChunkOptions {
  maxTokens?: number
  overlapTokens?: number
}

export interface TextChunk {
  /** Position within the document, from 0. */
  seq: number
  /** Exactly `input.slice(charStart, charEnd)`. */
  text: string
  tokenCount: number
  charStart: number
  charEnd: number
  /** Enclosing markdown headings, outermost first; empty before the first heading. */
  headingPath: string[]
  /** The table's header + delimiter rows, when this chunk holds rows of a table but not its header. */
  tableHeader: string | null
  /** Page of the source document — always null today (no page markers to read). */
  page: number | null
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** `['A', 'B']` → `'A › B'`; an empty path → null (the column's value for "no heading"). */
export function headingPathLabel(path: readonly string[]): string | null {
  return path.length > 0 ? path.join(HEADING_PATH_SEPARATOR) : null
}

/**
 * What gets EMBEDDED for a chunk: heading path, then table header, then the text — context the
 * stored slice lacks. `chunks.search_vector` indexes the same three, in the same order.
 */
export function embeddingInput(
  chunk: Pick<TextChunk, 'text' | 'headingPath' | 'tableHeader'>
): string {
  return [headingPathLabel(chunk.headingPath), chunk.tableHeader, chunk.text]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
}

/** The last ~`chars` characters of `text`, starting at a word boundary (never mid-word). */
export function overlapTail(text: string, chars: number): string {
  const start = overlapStart(text, 0, text.length, chars)
  return start === null ? '' : text.slice(start)
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

/**
 * Where the next window starts so it repeats the last ~`chars` of `[start, end)`: the first word
 * boundary at or after `end - chars`. The whole range when it is that short; null for no overlap.
 */
function overlapStart(text: string, start: number, end: number, chars: number): number | null {
  if (chars <= 0) return null
  if (end - start <= chars) return start
  const pos = end - chars
  let k = pos
  while (k < end && !isSpace(text[k])) k++
  if (k >= end) return pos // one word longer than the overlap: cut inside it, as before
  while (k < end && isSpace(text[k])) k++
  return k < end ? k : null
}

/** `[start, end)` without leading/trailing whitespace; null when nothing is left. */
function trimRange(text: string, start: number, end: number): [number, number] | null {
  let s = start
  let e = end
  while (s < e && isSpace(text[s])) s++
  while (e > s && isSpace(text[e - 1])) e--
  return s < e ? [s, e] : null
}

// ---- Lines, sections, blocks -------------------------------------------------------------------

interface Line {
  start: number
  /** End of the content, before `\r\n` / `\n`. */
  end: number
  text: string
  /** Inside a fenced code block, or one of its fence lines. */
  code: boolean
  /** Set on an ATX heading line: level and title. */
  heading: { level: number; title: string } | null
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const TABLE_DELIMITER_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let fence: { char: string; length: number } | null = null
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const lineEnd = nl === -1 ? text.length : nl
    const end = lineEnd > start && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    const content = text.slice(start, end)
    const marker = FENCE_RE.exec(content)?.[1]
    let code = fence !== null
    let heading: Line['heading'] = null
    if (fence) {
      if (
        marker &&
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        content.trim() === marker
      )
        fence = null
    } else if (
      marker &&
      !(marker[0] === '`' && content.trimStart().slice(marker.length).includes('`'))
    ) {
      // (A backtick fence's info string cannot hold a backtick — that line is inline code.)
      fence = { char: marker[0] as string, length: marker.length }
      code = true
    } else {
      const match = HEADING_RE.exec(content)
      if (match) heading = { level: (match[1] as string).length, title: (match[2] ?? '').trim() }
    }
    lines.push({ start, end, text: content, code, heading })
    if (nl === -1) break
    start = nl + 1
  }
  return lines
}

interface Section {
  path: string[]
  lines: Line[]
}

/** Cut the lines at every heading; each section knows the heading stack it sits under. */
function splitSections(lines: Line[]): Section[] {
  const sections: Section[] = [{ path: [], lines: [] }]
  const stack: { level: number; title: string }[] = []
  for (const line of lines) {
    if (line.heading) {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= line.heading.level)
        stack.pop()
      stack.push(line.heading)
      sections.push({ path: stack.map(h => h.title).filter(Boolean), lines: [] })
    }
    sections[sections.length - 1]?.lines.push(line)
  }
  return sections
}

interface Block {
  kind: 'paragraph' | 'table'
  start: number
  end: number
  /** Tables only: the header + delimiter rows' text, and each body row's range. */
  header?: string
  headerEnd?: number
  rows?: [number, number][]
}

const isBlank = (line: Line) => line.text.trim() === ''

function isTableStart(lines: Line[], i: number): boolean {
  const head = lines[i]
  const delimiter = lines[i + 1]
  return (
    head !== undefined &&
    delimiter !== undefined &&
    !head.code &&
    !head.heading &&
    !delimiter.code &&
    head.text.includes('|') &&
    delimiter.text.includes('|') &&
    TABLE_DELIMITER_RE.test(delimiter.text)
  )
}

/** A section's paragraphs and tables, as trimmed ranges into the text. */
function splitBlocks(text: string, lines: Line[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as Line
    if (isBlank(line)) {
      i++
      continue
    }
    if (isTableStart(lines, i)) {
      const delimiter = lines[i + 1] as Line
      const rows: [number, number][] = []
      let j = i + 2
      while (j < lines.length) {
        const row = lines[j] as Line
        if (isBlank(row) || row.code || !row.text.includes('|')) break
        const range = trimRange(text, row.start, row.end)
        if (range) rows.push(range)
        j++
      }
      const head = trimRange(text, line.start, delimiter.end) as [number, number]
      blocks.push({
        kind: 'table',
        start: head[0],
        end: rows.length > 0 ? (rows[rows.length - 1] as [number, number])[1] : head[1],
        header: text.slice(head[0], head[1]),
        headerEnd: head[1],
        rows,
      })
      i = j
      continue
    }
    const first = i
    while (i < lines.length && !isBlank(lines[i] as Line) && !(i > first && isTableStart(lines, i)))
      i++
    const range = trimRange(text, line.start, (lines[i - 1] as Line).end)
    if (range) blocks.push({ kind: 'paragraph', start: range[0], end: range[1] })
  }
  return blocks
}

/** The headings two paths share, outermost first. */
function commonPrefix(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i] as string)
  return out
}

// ---- Packing -----------------------------------------------------------------------------------

interface Piece {
  start: number
  end: number
  path: string[]
  tableHeader: string | null
}

/**
 * Split `text` into overlapping, structure-aligned chunks. Empty / whitespace-only input yields
 * no chunks. Every chunk is a non-empty exact slice, carries fresh text (never only the overlap)
 * and is at most `maxTokens` (estimated) unless a single word exceeds it.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = (options.maxTokens ?? DEFAULT_CHUNK_TOKENS) * CHARS_PER_TOKEN
  const overlapChars = Math.min(
    (options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS) * CHARS_PER_TOKEN,
    Math.floor(maxChars / 2)
  )
  const out: Piece[] = []

  // Whole sections that fit a window are packed together, so a document of many short sections
  // does not become a heap of fragments (a two-line `## Parties` alone is a poor passage). A chunk
  // still begins and ends at a heading: only a section larger than a window is cut inside, by the
  // paragraph packing below. A group's path is what its sections share.
  let group: { start: number; end: number; path: string[] } | null = null
  const flushGroup = () => {
    if (group) out.push({ start: group.start, end: group.end, path: group.path, tableHeader: null })
    group = null
  }

  for (const section of splitSections(splitLines(text))) {
    const first = section.lines[0]
    const last = section.lines[section.lines.length - 1]
    const span = first && last ? trimRange(text, first.start, last.end) : null
    if (!span) continue
    if (span[1] - span[0] <= maxChars) {
      const current = group as { start: number; end: number; path: string[] } | null
      if (current && span[1] - current.start <= maxChars) {
        current.end = span[1]
        current.path = commonPrefix(current.path, section.path)
      } else {
        flushGroup()
        group = { start: span[0], end: span[1], path: section.path }
      }
      continue
    }
    flushGroup()
    const blocks = splitBlocks(text, section.lines)
    const emit = (start: number, end: number, tableHeader: string | null = null) => {
      const range = trimRange(text, start, end)
      if (range) out.push({ start: range[0], end: range[1], path: section.path, tableHeader })
    }
    /** Hard-split `[start, end)` into word-bounded windows with the overlap; returns the last. */
    const splitLong = (
      start: number,
      end: number,
      tableHeader: string | null,
      limit = maxChars
    ): [number, number] => {
      let from = start
      let last: [number, number] = [start, end]
      while (from < end) {
        let to = Math.min(end, from + limit)
        // Prefer a word boundary for the cut unless that would lose more than a quarter of the window.
        if (to < end) {
          const boundary = text.lastIndexOf(' ', to)
          if (boundary > from + limit * 0.75) to = boundary
        }
        emit(from, to, tableHeader)
        last = [from, to]
        if (to >= end) break
        const next = overlapStart(text, from, to, overlapChars)
        from = next !== null && next > from ? next : to
        while (from < end && isSpace(text[from])) from++
      }
      return last
    }
    /** An oversized table: windows of whole rows, overlapping by whole rows. */
    const splitTable = (table: Block, leadStart: number) => {
      const rows = table.rows ?? []
      const header = table.header ?? ''
      const laterLimit = Math.max(Math.floor(maxChars / 2), maxChars - header.length - 2)
      let first = true // the first window opens with the header itself (and any lead-in text)
      let winStart = leadStart
      let winRow = 0 // first row in the current window (overlap rows included)
      let idx = 0 // first row not yet emitted
      while (idx < rows.length) {
        const limit = first ? maxChars : laterLimit
        let j = idx
        while (j < rows.length && (rows[j] as [number, number])[1] - winStart <= limit) j++
        const row = rows[idx] as [number, number]
        if (j === idx) {
          if (first) {
            emit(leadStart, table.headerEnd ?? table.start) // a header too wide to share
            first = false
            winStart = row[0]
            winRow = idx
          } else if (winStart < row[0]) {
            winStart = row[0] // drop the overlap rows; the fresh row alone may fit
            winRow = idx
          } else {
            splitLong(row[0], row[1], header, laterLimit) // one row wider than a window
            idx++
            winStart = rows[idx]?.[0] ?? table.end
            winRow = idx
          }
          continue
        }
        emit(winStart, (rows[j - 1] as [number, number])[1], first ? null : header)
        let k = j
        while (
          k - 1 >= winRow &&
          (rows[j - 1] as [number, number])[1] - (rows[k - 1] as [number, number])[0] <=
            overlapChars
        )
          k--
        if (k === winRow && winRow < j) k = Math.min(j - 1, winRow + 1) // never repeat a whole window
        first = false
        idx = j
        winRow = k < j ? k : j
        winStart = rows[winRow]?.[0] ?? table.end
      }
      if (rows.length === 0) emit(leadStart, table.end)
    }

    let carry: number | null = null // where the next window starts (the overlap), if earlier
    let fresh: Block[] = [] // blocks not yet emitted
    const flush = () => {
      if (fresh.length === 0) return
      const start = carry ?? (fresh[0] as Block).start
      const end = (fresh[fresh.length - 1] as Block).end
      emit(start, end)
      carry = overlapStart(text, start, end, overlapChars)
      // An overlap that opens inside a table would hand the next chunk rows without their header.
      if (
        carry !== null &&
        fresh.some(b => b.kind === 'table' && carry !== null && carry > b.start && carry < b.end)
      )
        carry = null
      fresh = []
    }

    for (const block of blocks) {
      if (block.end - block.start > maxChars) {
        if (block.kind === 'table') {
          // The text leading into the table (its heading, a caption) opens the first window when
          // it fits beside the header; otherwise it is a chunk of its own.
          const lead = fresh.length > 0 ? (carry ?? (fresh[0] as Block).start) : block.start
          if (fresh.length > 0 && (block.headerEnd ?? block.start) - lead <= maxChars) {
            fresh = []
            splitTable(block, lead)
          } else {
            flush()
            splitTable(block, block.start)
          }
          carry = null
        } else {
          flush()
          const [start, end] = splitLong(block.start, block.end, null)
          carry = overlapStart(text, start, end, overlapChars)
        }
        continue
      }
      if (fresh.length > 0 && block.end - (carry ?? (fresh[0] as Block).start) > maxChars) flush()
      // The overlap alone may not push a lone block over the window; drop it if it would.
      if (fresh.length === 0 && carry !== null && block.end - carry > maxChars) carry = null
      fresh.push(block)
    }
    flush()
  }
  flushGroup()

  return out.map((piece, seq) => {
    const slice = text.slice(piece.start, piece.end)
    return {
      seq,
      text: slice,
      tokenCount: estimateTokens(slice),
      charStart: piece.start,
      charEnd: piece.end,
      headingPath: piece.path,
      tableHeader: piece.tableHeader,
      page: null,
    }
  })
}

/**
 * The text a document is stored and chunked as: control characters stripped by the caller, line
 * endings normalised to `\n`, so `documents.content` and every chunk's offsets agree and two
 * uploads differing only in line endings hash alike.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}
