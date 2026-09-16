/**
 * One form field, in the kit's closed set of five types (decision 7). The SAME renderer serves the
 * `form` interrupt kind and the fallback run form for an agent with no hand-written entry, which is
 * what makes the fourth interrupt kind nearly free.
 *
 * It renders a field; it does not own the draft, validate, or decide what a missing value means.
 * All three belong to the caller, which holds the shared zod schema the server will apply.
 */
import type { FormField } from '@rocketflare/shared/ai/interrupts'
import { FieldError } from '@/ui/components/shared'

export interface FieldInputProps {
  field: FormField
  /** DOM id prefix, so two forms on one page never collide. */
  idPrefix: string
  value: unknown
  onChange: (value: unknown) => void
  error?: string
  disabled?: boolean
}

export function FieldInput({ field, idPrefix, value, onChange, error, disabled }: FieldInputProps) {
  const id = `${idPrefix}-${field.name}`
  const invalid = error ? true : undefined
  const describedBy = field.description ? `${id}-hint` : undefined

  const label = (
    <label htmlFor={id} className="label text-sm font-medium">
      {field.label}
      {field.required && (
        <span className="text-error" aria-hidden="true">
          *
        </span>
      )}
    </label>
  )

  const hint = field.description ? (
    <p id={describedBy} className="text-xs text-muted mt-1">
      {field.description}
    </p>
  ) : null

  if (field.type === 'boolean') {
    return (
      <div>
        <label className="label cursor-pointer justify-start gap-3" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={value === true}
            disabled={disabled}
            aria-describedby={describedBy}
            onChange={e => onChange(e.target.checked)}
          />
          <span className="text-sm">{field.label}</span>
        </label>
        {hint}
        <FieldError message={error} />
      </div>
    )
  }

  if (field.type === 'select') {
    return (
      <div>
        {label}
        <select
          id={id}
          className={`select select-sm w-full ${error ? 'select-error' : ''}`}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}
        >
          {/* An unanswered optional select needs a way back to "nothing"; a required one starts
              blank so the person makes the choice rather than inheriting the first option. */}
          <option value="">Choose…</option>
          {(field.options ?? []).map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {hint}
        <FieldError message={error} />
      </div>
    )
  }

  if (field.type === 'number') {
    return (
      <div>
        {label}
        <input
          id={id}
          type="number"
          className={`input input-sm w-full ${error ? 'input-error' : ''}`}
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          min={field.min}
          max={field.max}
          disabled={disabled}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}
        />
        {hint}
        <FieldError message={error} />
      </div>
    )
  }

  const text = typeof value === 'string' ? value : ''
  return (
    <div>
      {label}
      {field.type === 'textarea' ? (
        <textarea
          id={id}
          className={`textarea w-full text-sm leading-relaxed ${error ? 'textarea-error' : ''}`}
          rows={4}
          value={text}
          maxLength={field.maxLength}
          disabled={disabled}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          className={`input input-sm w-full ${error ? 'input-error' : ''}`}
          value={text}
          maxLength={field.maxLength}
          disabled={disabled}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {hint}
      <FieldError message={error} />
    </div>
  )
}
