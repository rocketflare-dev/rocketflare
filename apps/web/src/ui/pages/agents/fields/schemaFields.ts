/**
 * JSON Schema → the kit's closed set of form fields, or **nothing at all**.
 *
 * One renderer serves two callers (issue #17): the run form for an agent with no hand-written
 * `forms/` entry (`agentInfoSchema.inputJsonSchema`, produced server-side by `toolInputSchema()`)
 * and the `form` interrupt kind (`Interrupt.responseSchema`). They carry the same shape, which is
 * why the fourth interrupt kind cost almost nothing.
 *
 * > **`$ref`, `allOf`/`anyOf`/`oneOf`, nested objects and tuples return `null`, and the caller
 * > falls back to the JSON textarea WHOLE — never per field.**
 *
 * That rule is the reason this file is small. A renderer that skipped the one field it did not
 * understand would post an object missing a required key, and the failure would be invisible until
 * the run 400s — long after the person who filled the form has gone. Refusing the whole form is
 * loud, correct, and always answerable.
 *
 * Nothing zod reaches the client: the SERVER converts its zod schema once and the derived JSON
 * Schema is the contract, which is what holds the zod-3/zod-4 boundary.
 */
import type { FormField } from '@rocketflare/shared/ai/interrupts'
import { FORM_FIELD_MAX_LENGTH, type JsonSchema } from '@rocketflare/shared/ai/interrupts'

/** A field plus the default the schema declared for it. */
export interface FieldSpec extends FormField {
  /** `default` from the schema, used to seed the draft. */
  defaultValue?: unknown
}

/** Keywords that mean "this is more than the five field types we render". */
const UNSUPPORTED_KEYWORDS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'patternProperties']

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** An enum of plain strings becomes a `select`; anything else in the array refuses the form. */
function enumOptions(values: unknown): FormField['options'] | null {
  if (!Array.isArray(values) || values.length === 0) return null
  const options: NonNullable<FormField['options']> = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) return null
    options.push({ value, label: value })
  }
  return options
}

/**
 * The label when the schema declares no `title` — which is EVERY field the kit's own agents emit,
 * because `zodToJsonSchema` has no zod construct to read a title from. A raw property name read as
 * `topic` where a person expects `Topic`, so the fallback is the name made presentable: split on
 * `_`/`-`/camel humps, capitalise the first word. It invents nothing — an agent that wants better
 * words gives its schema a `title`.
 */
export function humaniseFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (words.length === 0) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function fieldFrom(name: string, raw: unknown, required: boolean): FieldSpec | null {
  const schema = asRecord(raw)
  if (!schema) return null
  if (UNSUPPORTED_KEYWORDS.some(keyword => keyword in schema)) return null

  const base = {
    name,
    label: asString(schema.title) ?? humaniseFieldName(name),
    required,
    ...(asString(schema.description)
      ? { description: asString(schema.description) as string }
      : {}),
    ...(schema.default !== undefined ? { defaultValue: schema.default } : {}),
  }

  const options = schema.enum !== undefined ? enumOptions(schema.enum) : null
  if (schema.enum !== undefined) {
    // An enum we cannot render is a refusal, not a text box: a free-text answer to a closed set is
    // a 400 waiting to happen.
    if (!options) return null
    return { ...base, type: 'select', options }
  }

  const type = schema.type
  if (type === 'boolean') return { ...base, type: 'boolean' }
  if (type === 'number' || type === 'integer') {
    return {
      ...base,
      type: 'number',
      ...(asNumber(schema.minimum) !== undefined ? { min: asNumber(schema.minimum) } : {}),
      ...(asNumber(schema.maximum) !== undefined ? { max: asNumber(schema.maximum) } : {}),
    }
  }
  if (type === 'string') {
    const maxLength = asNumber(schema.maxLength)
    // Anything that could hold a paragraph gets the bigger box; the kit's own agents lean on it.
    const long = maxLength === undefined || maxLength > 200
    return {
      ...base,
      type: long ? 'textarea' : 'text',
      ...(maxLength !== undefined && maxLength <= FORM_FIELD_MAX_LENGTH ? { maxLength } : {}),
    }
  }
  // Arrays, objects, tuples, untyped: out of the closed set.
  return null
}

/**
 * The top-level object's properties as fields, or `null` when ANY of them is out of the set.
 * An empty object answers `[]` — a form with no questions, which the caller renders as "nothing to
 * fill in" rather than as a JSON box.
 */
export function fieldsFromJsonSchema(schema: JsonSchema | null | undefined): FieldSpec[] | null {
  const root = asRecord(schema)
  if (!root) return null
  if (UNSUPPORTED_KEYWORDS.some(keyword => keyword in root)) return null
  if (root.type !== undefined && root.type !== 'object') return null
  const properties = asRecord(root.properties)
  if (!properties) return null

  const required = new Set(
    Array.isArray(root.required) ? root.required.filter(v => typeof v === 'string') : []
  )
  const fields: FieldSpec[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const field = fieldFrom(name, raw, required.has(name))
    if (!field) return null
    fields.push(field)
  }
  return fields
}

/** The draft a set of fields starts from: declared defaults, else empty. */
export function initialValuesFor(fields: readonly FieldSpec[]): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      values[field.name] = field.defaultValue
      continue
    }
    if (field.type === 'boolean') values[field.name] = false
    else if (field.type === 'select') values[field.name] = field.options?.[0]?.value ?? ''
    else if (field.type === 'number') values[field.name] = ''
    else values[field.name] = ''
  }
  return values
}

/**
 * The draft as the server must receive it. **Empty optional fields are DROPPED, not sent as `''`**:
 * `formValuesSchemaFor` builds a `.strict()` object, so a key the form never asked for — or an
 * empty string where a number belongs — is a 400.
 */
export function submittableValues(
  fields: readonly FieldSpec[],
  draft: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    const value = draft[field.name]
    if (field.type === 'boolean') {
      values[field.name] = Boolean(value)
      continue
    }
    if (field.type === 'number') {
      if (value === '' || value === undefined || value === null) continue
      const parsed = typeof value === 'number' ? value : Number(value)
      values[field.name] = Number.isNaN(parsed) ? value : parsed
      continue
    }
    if (typeof value === 'string' && value.length === 0 && !field.required) continue
    if (value === undefined || value === null) continue
    values[field.name] = value
  }
  return values
}
