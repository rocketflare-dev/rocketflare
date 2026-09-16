/**
 * The middle rung of `formFor` (issue #17): a form built from the agent's own `inputJsonSchema`,
 * for an agent that has no hand-written entry but whose input IS one flat object of the five field
 * types. Below a registered form, above the JSON textarea.
 *
 * `schemaForm` returns `null` when `fieldsFromJsonSchema` refuses the schema — and it refuses the
 * WHOLE schema rather than the one field it did not understand, because a form that silently drops
 * a required field posts an invalid body and the person who filled it in is long gone by the time
 * the run 400s.
 *
 * Client-side validation is deliberately thin here: the shared schema lives on the server for an
 * unregistered agent, so the route's 400 `details` is the authority and `issuesFrom` maps it back
 * onto the fields.
 */
import type { JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { z } from 'zod'
import { FieldSet } from '../fields/FieldSet'
import {
  type FieldSpec,
  fieldsFromJsonSchema,
  initialValuesFor,
  submittableValues,
} from '../fields/schemaFields'
import type { AgentForm, AgentFormProps } from './types'

type Draft = Record<string, unknown>

/** `null` when the schema is outside the closed set — the caller falls back to `jsonForm`. */
export function schemaForm(schema: JsonSchema | null | undefined): AgentForm<Draft> | null {
  const fields = fieldsFromJsonSchema(schema)
  if (!fields || fields.length === 0) return null

  function Component({ value, onChange, issues, disabled }: AgentFormProps<Draft>) {
    return (
      <FieldSet
        fields={fields as FieldSpec[]}
        idPrefix="agent-field"
        values={value}
        onChange={onChange}
        issues={issues}
        disabled={disabled}
      />
    )
  }

  return {
    initial: initialValuesFor(fields),
    // Empty optional fields are dropped rather than sent as `''`: the server validates with the
    // agent's real zod schema and an empty string where a number belongs is a 400.
    schema: z.custom<Draft>().transform(draft => submittableValues(fields, draft)),
    Component,
  }
}
