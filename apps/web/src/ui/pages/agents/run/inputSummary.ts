/**
 * What the run was ASKED to do, as labelled values rather than a `<pre>` of JSON — decided as data
 * so the component is only markup (`tests/config/run-timeline.test.ts`).
 *
 * The labels come from the agent's own `inputJsonSchema` through `fieldsFromJsonSchema`, the same
 * pure function the run form and the `form` interrupt kind use. That is deliberate: a third reading
 * of a JSON Schema in this repo would be a third set of bugs, and the one that exists already
 * refuses precisely the shapes nobody can label honestly.
 *
 * **The fallback is the JSON WHOLE, never per field** — the rule `schemaFields.ts` states and the
 * reason it states it. Two ways to land there, and both mean "we cannot describe this faithfully":
 * the schema is out of the closed set (`$ref`, `allOf`/`anyOf`/`oneOf`, nested objects, tuples), or
 * the input carries a key the schema never declared, which is an input the labels would silently
 * hide. A half-described input is worse than a JSON blob, because it reads as complete.
 */
import type { JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { fieldsFromJsonSchema } from '../fields/schemaFields'

/** Past this a value is clipped behind a "Show more"; `research-topic`'s question is the case. */
export const INPUT_VALUE_PREVIEW_CHARS = 240

export interface InputValue {
  name: string
  label: string
  /** Already rendered for a person: `true` → `Yes`, an absent optional → `—`. */
  text: string
  /** It is long enough to need the expand control. */
  long: boolean
}

export type InputSummary =
  | { kind: 'fields'; values: InputValue[] }
  | { kind: 'json'; text: string }
  /** Nothing was passed at all — an agent whose input schema is an empty object. */
  | { kind: 'empty' }

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function display(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') return value.length === 0 ? '—' : value
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function summariseInput(
  input: unknown,
  schema: JsonSchema | null | undefined
): InputSummary {
  const record = asRecord(input)
  if (input === null || input === undefined || (record && Object.keys(record).length === 0)) {
    return { kind: 'empty' }
  }
  const fields = record ? fieldsFromJsonSchema(schema) : null
  if (!fields || !record) return { kind: 'json', text: jsonText(input) }

  const declared = new Set(fields.map(field => field.name))
  // A key the schema never declared would be dropped by the labels and never seen again.
  if (Object.keys(record).some(key => !declared.has(key))) {
    return { kind: 'json', text: jsonText(input) }
  }

  return {
    kind: 'fields',
    values: fields.map(field => {
      const text = display(record[field.name])
      return {
        name: field.name,
        label: field.label,
        text,
        long: text.length > INPUT_VALUE_PREVIEW_CHARS,
      }
    }),
  }
}
