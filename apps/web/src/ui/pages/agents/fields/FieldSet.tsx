/**
 * A list of {@link FieldInput}s over one draft object. The caller owns the draft and the schema;
 * this maps issues onto fields by their first path segment, the same way every other kit form does.
 */
import type { FormField } from '@rocketflare/shared/ai/interrupts'
import type { Issue } from '../issues'
import { FieldInput } from './FieldInput'

export function FieldSet({
  fields,
  idPrefix,
  values,
  onChange,
  issues,
  disabled,
}: {
  fields: readonly FormField[]
  idPrefix: string
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  issues?: readonly Issue[]
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      {fields.map(field => (
        <FieldInput
          key={field.name}
          field={field}
          idPrefix={idPrefix}
          value={values[field.name]}
          disabled={disabled}
          error={
            issues?.find(issue => issue.path[0] === field.name || issue.path[1] === field.name)
              ?.message
          }
          onChange={value => onChange({ ...values, [field.name]: value })}
        />
      ))}
    </div>
  )
}
