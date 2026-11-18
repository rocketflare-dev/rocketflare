/**
 * A candidate fact's VALUE, made to fit the type's schema for its key (D43). The model is asked
 * for the declared shape and mostly gives it; when it does not, the value is coerced in code —
 * `£1,140` to 1140 for a number, `yes` / `not included` for a boolean, `premium` to the enum's
 * `Premium`, `"Essential, Standard"` to a list, a date phrase through `resolveDatePhrase` — and
 * then parsed with the key's own zod schema. A value that still does not parse is dropped, never
 * stored loose: a fact's `value` is always valid against its key when it is written.
 *
 * Pure. `valueText` is the normalised display form; `valueKey` the comparison key two facts must
 * share to "say the same thing" (phone numbers spaced differently, an email in another case, a
 * list in another order are the same value).
 */
import { z } from 'zod'
import { resolveDatePhrase } from './dates'

interface Def {
  type: string
  innerType?: z.ZodType
  in?: z.ZodType
  element?: z.ZodType
  entries?: Record<string, string | number>
  values?: readonly unknown[]
  format?: string
}

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'readonly', 'catch', 'nonoptional'])

/** The schema under `.optional()` / `.nullable()` / `.default()` … — what the value must BE. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let i = 0; i < 10; i++) {
    const def = defOf(current)
    if (WRAPPERS.has(def.type) && def.innerType) current = def.innerType
    else if (def.type === 'pipe' && def.in) current = def.in
    else break
  }
  return current
}

/** `date` / `date-time` for an ISO date string schema, else null — read from its JSON schema. */
export function dateFormatOf(schema: z.ZodType): 'date' | 'date-time' | null {
  try {
    const json = z.toJSONSchema(unwrap(schema)) as { format?: string }
    if (json.format === 'date' || json.format === 'date-time') return json.format
  } catch {
    // A schema that cannot render is not a date.
  }
  return null
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', 'included', 'include', 'includes', '✓', '✔'])
const FALSE_WORDS = new Set([
  'no',
  'n',
  'false',
  'not included',
  'excluded',
  'none',
  '✗',
  '✘',
  '-',
  '—',
])

function toNumber(raw: unknown): unknown {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') return raw
  const cleaned = raw.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[£$€]/g, '')
  const numbers = cleaned.match(/-?\d+(?:\.\d+)?/g)
  return numbers && numbers.length === 1 ? Number(numbers[0]) : raw
}

function toBoolean(raw: unknown): unknown {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return raw
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  if (/^(not|no)\b/.test(s) || /\bnot included\b/.test(s)) return false
  if (/^included\b/.test(s) || /^yes\b/.test(s)) return true
  return raw
}

function enumOptions(def: Def): string[] {
  if (def.entries) return Object.values(def.entries).map(String)
  if (def.values) return def.values.map(String)
  return []
}

function toEnum(raw: unknown, options: readonly string[]): unknown {
  if (typeof raw !== 'string') return raw
  const s = raw.trim().toLowerCase()
  const exact = options.find(o => o.toLowerCase() === s)
  if (exact) return exact
  // "Standard plan" → Standard: exactly one option appears as a whole word.
  const words = options.filter(o =>
    new RegExp(`\\b${o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)
  )
  return words.length === 1 ? words[0] : raw
}

function toArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    return raw
      .split(/\s*(?:,|;|\/|\band\b|&)\s*/i)
      .map(s => s.trim())
      .filter(Boolean)
  }
  if (raw === null || raw === undefined) return null
  return [raw]
}

/** Coerce `raw` toward `schema` without validating; the caller parses the result. */
function coerce(schema: z.ZodType, raw: unknown, documentDate: Date): unknown {
  const inner = unwrap(schema)
  const def = defOf(inner)
  const format = dateFormatOf(inner)
  if (format && typeof raw === 'string') {
    const date = resolveDatePhrase(raw, documentDate)
    if (!date) return raw
    return format === 'date' ? date : `${date}T00:00:00.000Z`
  }
  switch (def.type) {
    case 'number':
    case 'int':
      return toNumber(raw)
    case 'boolean':
      return toBoolean(raw)
    case 'enum':
      return toEnum(raw, enumOptions(def))
    case 'literal':
      return toEnum(raw, enumOptions(def))
    case 'array': {
      const items = toArray(raw)
      if (!items || !def.element) return raw
      const element = def.element
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const item of items.map(i => coerce(element, i, documentDate))) {
        const key = JSON.stringify(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    }
    case 'string':
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
      if (typeof raw === 'string') return raw.trim().replace(/\s+/g, ' ')
      return raw
    default:
      return raw
  }
}

export type CoercedValue = { ok: true; value: unknown } | { ok: false; reason: string }

/**
 * `raw` as a valid value of `schema`, or why not. Tries the value as given first, then coerced.
 * An empty value (`null`, `''`, `[]`) is never a fact.
 */
/**
 * A model's way of saying "no value": `<UNKNOWN>`, `N/A`, `TBD`, `none`, `null`. Never a fact —
 * a key the section does not state is simply not reported.
 */
const PLACEHOLDER =
  /^[<[(]?\s*(unknown|n\/?a|tbd|tbc|none|null|not stated|not specified)\s*[>\])]?$/i

export function coerceFactValue(
  schema: z.ZodType,
  given: unknown,
  documentDate: Date
): CoercedValue {
  const raw = typeof given === 'string' ? given.trim().replace(/\s+/g, ' ') : given
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty value' }
  if (typeof raw === 'string' && (raw.trim() === '' || PLACEHOLDER.test(raw))) {
    return { ok: false, reason: 'empty value' }
  }
  if (Array.isArray(raw) && raw.length === 0) return { ok: false, reason: 'empty value' }
  // A date is never taken as given unless it is already ISO: the model must not resolve dates.
  const direct = dateFormatOf(schema) ? undefined : schema.safeParse(raw)
  if (direct?.success && direct.data !== undefined && direct.data !== null) {
    return { ok: true, value: direct.data }
  }
  const coerced = schema.safeParse(coerce(schema, raw, documentDate))
  if (coerced.success && coerced.data !== undefined && coerced.data !== null) {
    if (Array.isArray(coerced.data) && coerced.data.length === 0) {
      return { ok: false, reason: 'empty value' }
    }
    return { ok: true, value: coerced.data }
  }
  return { ok: false, reason: 'value does not match the key' }
}

/** The display form: `1140`, `yes`, `Essential, Standard`, a trimmed string. */
export function valueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(valueText).join(', ')
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ')
  return JSON.stringify(value)
}

/**
 * The comparison key: two facts say the same thing when theirs are equal. Strings ignore case,
 * spacing and punctuation (keeping `@` and `.` so emails stay emails); numbers compare to the
 * hundredth; lists as sets.
 */
export function valueKey(value: unknown): string {
  if (typeof value === 'number') return `n:${Math.round(value * 100) / 100}`
  if (typeof value === 'boolean') return `b:${value}`
  if (Array.isArray(value)) return `a:${[...new Set(value.map(valueKey))].sort().join('|')}`
  if (typeof value === 'string') {
    return `s:${value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}@.]+/gu, '')
      .replace(/^\.+|\.+$/g, '')}`
  }
  return `j:${JSON.stringify(value)}`
}
