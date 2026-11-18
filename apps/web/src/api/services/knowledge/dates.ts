/**
 * Dates in knowledge facts are resolved in CODE, never by the model (D43): the model copies a date
 * phrase exactly as the document writes it, and `resolveDatePhrase` turns it into an ISO date
 * against the DOCUMENT's date — so "next Monday" in a memo written on 18 May 2026 is 25 May 2026
 * however late the memo is ingested, and a model cannot get the calendar wrong.
 *
 * Pure and UTC throughout. What it reads (each a test in `tests/config/knowledge-dates.test.ts`):
 *
 * - ISO `2027-01-31` (a datetime is cut to its date); UK numeric `31/01/2027`, `31.1.27`,
 *   `31-01-2027` — day first, always;
 * - `31 January 2027`, `31st Jan 2027`, `January 31, 2027`, `the 1st of November`, `30 Nov`;
 *   with no year, the doc's year — or the next one when that would put the date more than
 *   `PAST_WINDOW_DAYS` before the document (a price list in September "valid until 31 March" means
 *   next March);
 * - `March 2027` — the first of the month, or its last day for an END bound;
 * - `today` / `now` / `immediately` / `tomorrow` / `yesterday`;
 * - weekdays: `this Friday` (on or after the doc date), `next Tuesday` and a bare `Tuesday`
 *   (strictly after it: the next one to come), `last Monday` (strictly before);
 * - `in two weeks`, `in 3 days`, `in a fortnight`, `a month from now`;
 * - `next week` / `month` / `quarter` / `year` (their first day, or last for an END bound), and
 *   `the first|start|beginning|end|last day of this|next month|quarter|year`, `end of October`;
 * - a leading `from`, `until`, `by`, `on`, `as of`, `effective`, `starting`, `w/c`, … is ignored.
 *
 * Anything else is `null` — and the caller drops the fact rather than store a date it guessed.
 */

export type DateBound = 'start' | 'end'

/** A year-less "31 March" that would land more than this many days before the document is next year's. */
export const PAST_WINDOW_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
}
const MONTH_RE = Object.keys(MONTHS).join('|')

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}
const WEEKDAY_RE = Object.keys(WEEKDAYS).join('|')

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  'a couple of': 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

/** Leading words that frame a date without changing it, longest first so `effective from` wins. */
const PREFIXES = [
  'with effect from',
  'effective from',
  'week commencing',
  'commencing on',
  'starting from',
  'starting on',
  'no later than',
  'valid from',
  'valid until',
  'valid to',
  'from now on', // handled below: "from now on" alone means the doc date
  'as of',
  'as from',
  'up to',
  'effective',
  'commencing',
  'beginning',
  'starting',
  'from',
  'until',
  'till',
  'til',
  'to',
  'by',
  'on',
  'before',
  'after',
  'since',
  'through',
  'w/c',
  'wc',
] as const

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS)
const iso = (date: Date) => date.toISOString().slice(0, 10)
const lastDayOfMonth = (y: number, m: number) => utc(y, m + 1, 0)

/** A valid calendar date or null (`31/02/2027` is not one). */
function calendar(y: number, m: number, d: number): Date | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null
  const date = utc(y, m, d)
  return date.getUTCMonth() === m && date.getUTCDate() === d ? date : null
}

/** The doc's day at 00:00 UTC. */
function dayOf(doc: Date): Date {
  return utc(doc.getUTCFullYear(), doc.getUTCMonth(), doc.getUTCDate())
}

/** A year-less day and month, placed in the year the module comment describes. */
function inferYear(m: number, d: number, doc: Date): Date | null {
  const base = dayOf(doc)
  const same = calendar(base.getUTCFullYear(), m, d)
  if (!same) return null
  if (same.getTime() < base.getTime() - PAST_WINDOW_DAYS * DAY_MS) {
    return calendar(base.getUTCFullYear() + 1, m, d)
  }
  return same
}

function fullYear(y: string): number {
  const n = Number(y)
  return y.length <= 2 ? 2000 + n : n
}

function normalise(phrase: string): string {
  let s = phrase
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\(([^)]*)\)/g, ' $1 ')
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[.,;:!?]+$/g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (;;) {
    const prefix = PREFIXES.find(p => s === p || s.startsWith(`${p} `))
    if (!prefix || prefix === 'from now on') break
    const rest = s.slice(prefix.length).trim()
    if (!rest) break
    s = rest
  }
  return s
}

function startOf(unit: 'week' | 'month' | 'quarter' | 'year', date: Date): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  switch (unit) {
    case 'week': {
      const offset = (date.getUTCDay() + 6) % 7 // Monday = 0
      return addDays(dayOf(date), -offset)
    }
    case 'month':
      return utc(y, m, 1)
    case 'quarter':
      return utc(y, m - (m % 3), 1)
    case 'year':
      return utc(y, 0, 1)
  }
}

function shift(unit: 'week' | 'month' | 'quarter' | 'year', date: Date, n: number): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  switch (unit) {
    case 'week':
      return addDays(date, 7 * n)
    case 'month':
      return utc(y, m + n, 1)
    case 'quarter':
      return utc(y, m + 3 * n, 1)
    case 'year':
      return utc(y + n, 0, 1)
  }
}

function endOf(unit: 'week' | 'month' | 'quarter' | 'year', start: Date): Date {
  return addDays(shift(unit, start, 1), -1)
}

function amount(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word)
  return NUMBER_WORDS[word] ?? null
}

/**
 * The ISO date (`YYYY-MM-DD`) a phrase names, read against the document's date, or null when it
 * names none this resolver understands. `bound` decides which end of a whole period a phrase such
 * as `March 2027` or `next month` names — `start` for a value or a `validFrom`, `end` for a
 * `validTo`.
 */
export function resolveDatePhrase(
  phrase: string,
  documentDate: Date,
  bound: DateBound = 'start'
): string | null {
  if (typeof phrase !== 'string' || Number.isNaN(documentDate.getTime())) return null
  const raw = phrase.trim()
  if (!raw) return null
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?$/i.exec(raw)
  if (isoMatch) {
    const date = calendar(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
    return date ? iso(date) : null
  }
  const doc = dayOf(documentDate)
  const s = normalise(raw)
  const date = resolveNormalised(s, doc, bound)
  return date ? iso(date) : null
}

function resolveNormalised(s: string, doc: Date, bound: DateBound): Date | null {
  let m: RegExpExecArray | null

  // ISO after a prefix ("from 2027-01-31").
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return calendar(Number(m[1]), Number(m[2]) - 1, Number(m[3]))

  // UK numeric: day first.
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)
  if (m) return calendar(fullYear(m[3] ?? ''), Number(m[2]) - 1, Number(m[1]))

  if (/^(today|now|immediately|from now on|with immediate effect|this day)$/.test(s)) return doc
  if (s === 'tomorrow') return addDays(doc, 1)
  if (s === 'yesterday') return addDays(doc, -1)

  // "31 january 2027", "the 1 of november", "31 jan".
  m = new RegExp(`^(?:the )?(\\d{1,2})(?: of)? (${MONTH_RE})(?: (\\d{4}|'\\d{2}))?$`).exec(s)
  if (m) {
    const month = MONTHS[m[2] ?? ''] as number
    const day = Number(m[1])
    if (m[3]) return calendar(fullYear(m[3].replace("'", '')), month, day)
    return inferYear(month, day, doc)
  }

  // "january 31 2027", "january 31".
  m = new RegExp(`^(${MONTH_RE}) (\\d{1,2})(?: (\\d{4}))?$`).exec(s)
  if (m) {
    const month = MONTHS[m[1] ?? ''] as number
    const day = Number(m[2])
    if (m[3]) return calendar(Number(m[3]), month, day)
    return inferYear(month, day, doc)
  }

  // "march 2027" — a whole month.
  m = new RegExp(`^(${MONTH_RE}) (\\d{4})$`).exec(s)
  if (m) {
    const month = MONTHS[m[1] ?? ''] as number
    const year = Number(m[2])
    return bound === 'end' ? lastDayOfMonth(year, month) : utc(year, month, 1)
  }

  // "(the) end of october", "(the) start of march 2027".
  m = new RegExp(
    `^(?:the )?(start|beginning|first|end|last day) of (${MONTH_RE})(?: (\\d{4}))?$`
  ).exec(s)
  if (m) {
    const month = MONTHS[m[2] ?? ''] as number
    const first = m[3] ? utc(Number(m[3]), month, 1) : inferYear(month, 1, doc)
    if (!first) return null
    const atEnd = m[1] === 'end' || m[1] === 'last day'
    return atEnd ? lastDayOfMonth(first.getUTCFullYear(), month) : first
  }

  // Weekdays.
  m = new RegExp(`^(this|next|coming|this coming|last|on)? ?(${WEEKDAY_RE})s?$`).exec(s)
  if (m) {
    const target = WEEKDAYS[m[2] ?? ''] as number
    const ahead = (target - doc.getUTCDay() + 7) % 7
    if (m[1] === 'this') return addDays(doc, ahead)
    if (m[1] === 'last') return addDays(doc, -((doc.getUTCDay() - target + 7) % 7 || 7))
    return addDays(doc, ahead === 0 ? 7 : ahead)
  }

  // "in two weeks", "a month from now", "in a fortnight".
  m =
    /^(?:in )?(\d+|a couple of|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|week|fortnight|month|year)s?(?: from now| from today| time)?$/.exec(
      s
    )
  if (m && (s.startsWith('in ') || /from (now|today)| time$/.test(s))) {
    const n = amount(m[1] ?? '')
    if (n === null) return null
    switch (m[2]) {
      case 'day':
        return addDays(doc, n)
      case 'week':
        return addDays(doc, 7 * n)
      case 'fortnight':
        return addDays(doc, 14 * n)
      case 'month': {
        const target = utc(doc.getUTCFullYear(), doc.getUTCMonth() + n, 1)
        const last = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()).getUTCDate()
        return utc(target.getUTCFullYear(), target.getUTCMonth(), Math.min(doc.getUTCDate(), last))
      }
      case 'year':
        return (
          calendar(doc.getUTCFullYear() + n, doc.getUTCMonth(), doc.getUTCDate()) ??
          lastDayOfMonth(doc.getUTCFullYear() + n, doc.getUTCMonth())
        )
    }
  }

  // "(the) first|start|end of (this|next|the following) month|quarter|year".
  m =
    /^(?:the )?(first|1|first day|start|beginning|end|last day) of (?:the )?(this|next|the following|following|current)? ?(week|month|quarter|year)$/.exec(
      s
    )
  if (m) {
    const unit = m[3] as 'week' | 'month' | 'quarter' | 'year'
    const which = m[2] ?? 'this'
    const n = which === 'this' || which === 'current' ? 0 : 1
    const start = shift(unit, startOf(unit, doc), n)
    const atEnd = m[1] === 'end' || m[1] === 'last day'
    return atEnd ? endOf(unit, start) : start
  }

  // "next month", "this quarter", "next year".
  m = /^(this|next|the following|following|the next) (week|month|quarter|year)$/.exec(s)
  if (m) {
    const unit = m[2] as 'week' | 'month' | 'quarter' | 'year'
    const start = shift(unit, startOf(unit, doc), m[1] === 'this' ? 0 : 1)
    return bound === 'end' ? endOf(unit, start) : start
  }

  // "end of month", "end of the year" (this one).
  m = /^(?:the )?end of (?:the )?(week|month|quarter|year)$/.exec(s)
  if (m) {
    const unit = m[1] as 'week' | 'month' | 'quarter' | 'year'
    return endOf(unit, startOf(unit, doc))
  }

  return null
}
