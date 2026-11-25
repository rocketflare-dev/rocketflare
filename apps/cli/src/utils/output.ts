/**
 * Data output. `Output.data(raw, human)` prints the server's raw JSON under `--json` or the
 * human rendering otherwise — both to STDOUT. Tables are plain text (no box drawing) so they diff
 * and grep well.
 */
import chalk from 'chalk'

export interface Output {
  readonly json: boolean
  /** Print `raw` as JSON under `--json`, otherwise the result of `human()`. */
  data(raw: unknown, human: () => string): void
  /** Print a human-only line (skipped under `--json`). */
  text(line: string): void
}

export interface OutputOptions {
  json?: boolean
  write?: (chunk: string) => void
}

export function createOutput(options: OutputOptions = {}): Output {
  const json = options.json ?? false
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk))
  return {
    json,
    data: (raw, human) => write(`${json ? formatJson(raw) : human()}\n`),
    text: line => {
      if (!json) write(`${line}\n`)
    },
  }
}

/** An output that records what was written — for tests. */
export function createMemoryOutput(json = false): Output & { chunks: string[]; content(): string } {
  const chunks: string[] = []
  const output = createOutput({ json, write: chunk => chunks.push(chunk) })
  return Object.assign(output, { chunks, content: () => chunks.join('') })
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Text that came from a server or another user, made inert for a terminal: C0 controls (a carriage
 * return becomes a line break, a tab and a line break stay), DEL and C1 are removed, so it cannot
 * move the cursor, erase a row or set the window title. Applied to the data, before any styling,
 * because chalk's own colour codes start with the same ESC. `--json` never comes through here.
 */
export function neutralise(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
}

export interface Column<Row> {
  header: string
  /** The cell's data: formatted and neutralised by `renderTable`, so never a pre-styled string. */
  value: (row: Row) => unknown
  /** Colour for the cell, applied after formatting and padding so widths are the unstyled ones. */
  style?: (text: string, row: Row) => string
}

/** Left-aligned columns separated by two spaces; header in bold; `-` for null/undefined. */
export function renderTable<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string {
  if (rows.length === 0) return chalk.dim('(no results)')
  const cells = rows.map(row => columns.map(column => formatCell(column.value(row))))
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map(line => line[i]?.length ?? 0))
  )
  const pad = (text: string, i: number) =>
    i === columns.length - 1 ? text : text.padEnd(widths[i] ?? 0)
  const header = columns.map((column, i) => pad(column.header, i)).join('  ')
  const body = cells.map((line, r) =>
    line
      .map((text, i) => {
        const padded = pad(text, i)
        const style = columns[i]?.style
        const row = rows[r]
        return style && row !== undefined ? style(padded, row) : padded
      })
      .join('  ')
  )
  return [chalk.bold(header), ...body].join('\n')
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  if (value instanceof Date) return formatDate(value)
  if (Array.isArray(value)) return value.map(formatCell).join(',')
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  // One line per row: a line break in a cell would print a row the table does not have.
  return neutralise(text).replace(/[\t\n]+/g, ' ')
}

/** `2026-09-01 07:54` in local time, or `-` for null. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '-'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `Page 2/5 · 113 items` — footer for paginated lists. */
export function formatPagination(meta: {
  page: number
  totalPages: number
  total: number
  pageSize: number
}): string {
  return chalk.dim(
    `Page ${meta.page}/${meta.totalPages} · ${meta.total} total · ${meta.pageSize} per page`
  )
}
