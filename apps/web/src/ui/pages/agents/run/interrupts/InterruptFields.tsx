/**
 * The answer half of one ask, dispatched on `kind`.
 *
 * The switch is **exhaustive over the shared union**, so a fifth interrupt kind is a type error
 * here until it has a branch — which is the whole reason the kinds are a closed set rather than a
 * generic JSON-Schema form generator (decision 7). It renders inputs and reports a draft; the
 * validating, the posting and the buttons belong to `ActionRequiredPanel`.
 */
import type { AgentInterruptSpec, ApprovalTool } from '@rocketflare/shared/ai/interrupts'
import { FieldError } from '@/ui/components/shared'
import { FieldSet } from '../../fields/FieldSet'
import type { Issue } from '../../issues'
import { ToolCallPreview } from './ToolCallPreview'

/** The whole draft an ask can hold. One shape for four kinds keeps the panel's state flat. */
export interface AnswerDraft {
  /** `choice` */
  value: string
  /** `choice` with `allowOther`: the free-text alternative. */
  other: string
  /** `input` */
  text: string
  /** `form` */
  values: Record<string, unknown>
  /** `approval` with `tool.allowEdits`: the raw JSON of an edit, or null for the original. */
  editedInput: string | null
  /** Any kind: the note attached to the answer. */
  note: string
}

export const EMPTY_DRAFT: AnswerDraft = {
  value: '',
  other: '',
  text: '',
  values: {},
  editedInput: null,
  note: '',
}

/** The free-text option's sentinel; it is not a legal `options[].value` (those are `min(1)`). */
export const OTHER_VALUE = ''

export function InterruptFields({
  spec,
  draft,
  onChange,
  issues,
  disabled,
}: {
  spec: AgentInterruptSpec
  draft: AnswerDraft
  onChange: (draft: AnswerDraft) => void
  issues?: readonly Issue[]
  disabled?: boolean
}) {
  const errorFor = (field: string) => issues?.find(issue => issue.path[0] === field)?.message

  switch (spec.kind) {
    case 'approval':
      return spec.tool ? (
        <ToolCallPreview
          tool={spec.tool as ApprovalTool}
          edited={draft.editedInput}
          onEdit={editedInput => onChange({ ...draft, editedInput })}
          error={errorFor('editedInput')}
          disabled={disabled}
        />
      ) : null

    case 'choice':
      return (
        <fieldset className="space-y-1.5" disabled={disabled}>
          <legend className="sr-only">Choose an answer</legend>
          {spec.options.map(option => (
            <label
              key={option.value}
              className="flex items-start gap-2.5 cursor-pointer rounded-[var(--radius-control)] p-1.5 hover:bg-[color:var(--surface-hover)]"
            >
              <input
                type="radio"
                name="interrupt-choice"
                className="radio radio-sm mt-0.5"
                value={option.value}
                checked={draft.value === option.value}
                onChange={() => onChange({ ...draft, value: option.value })}
              />
              <span className="min-w-0">
                <span className="text-sm">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-muted">{option.description}</span>
                )}
              </span>
            </label>
          ))}
          {spec.allowOther && (
            <label className="flex items-start gap-2.5 cursor-pointer rounded-[var(--radius-control)] p-1.5">
              <input
                type="radio"
                name="interrupt-choice"
                className="radio radio-sm mt-0.5"
                value={OTHER_VALUE}
                checked={draft.value === OTHER_VALUE}
                onChange={() => onChange({ ...draft, value: OTHER_VALUE })}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Something else</span>
                <input
                  type="text"
                  className="input input-sm w-full mt-1"
                  value={draft.other}
                  aria-label="Something else"
                  onChange={e => onChange({ ...draft, other: e.target.value, value: OTHER_VALUE })}
                />
              </span>
            </label>
          )}
          <FieldError message={errorFor('value')} />
        </fieldset>
      )

    case 'input':
      return (
        <div>
          <label htmlFor="interrupt-text" className="sr-only">
            Your answer
          </label>
          {spec.multiline ? (
            <textarea
              id="interrupt-text"
              className={`textarea w-full text-sm ${errorFor('text') ? 'textarea-error' : ''}`}
              rows={4}
              value={draft.text}
              maxLength={spec.maxLength}
              placeholder={spec.placeholder}
              disabled={disabled}
              onChange={e => onChange({ ...draft, text: e.target.value })}
            />
          ) : (
            <input
              id="interrupt-text"
              type="text"
              className={`input input-sm w-full ${errorFor('text') ? 'input-error' : ''}`}
              value={draft.text}
              maxLength={spec.maxLength}
              placeholder={spec.placeholder}
              disabled={disabled}
              onChange={e => onChange({ ...draft, text: e.target.value })}
            />
          )}
          <FieldError message={errorFor('text')} />
        </div>
      )

    case 'form':
      return (
        <FieldSet
          fields={spec.fields}
          idPrefix="interrupt-form"
          values={draft.values}
          onChange={values => onChange({ ...draft, values })}
          issues={issues}
          disabled={disabled}
        />
      )
  }
}
