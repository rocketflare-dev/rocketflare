/**
 * Input form for the `summarize-text` example agent (D7, D17): the text (counted against
 * `SUMMARIZE_TEXT_MAX_CHARS`), the style, and the "index the result" toggle that also stores the
 * summary as a searchable document (D18). Validated with the SAME `summarizeTextInputSchema` the
 * route and the runtime apply, so a 400 is a backstop, not the UX.
 */
import {
  SUMMARIZE_TEXT_MAX_CHARS,
  type SummarizeTextInput,
  summarizeTextInputSchema,
} from '@gmgo/shared/ai/agents'
import { FieldError, fieldErrorFor } from '@/ui/components/shared'
import type { AgentForm, AgentFormProps } from './types'

type Draft = { text: string; style: SummarizeTextInput['style']; index: boolean }

const INITIAL: Draft = { text: '', style: 'bullets', index: false }

function SummarizeTextForm({ value, onChange, issues, disabled }: AgentFormProps<Draft>) {
  const over = value.text.length > SUMMARIZE_TEXT_MAX_CHARS
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between">
          <label htmlFor="agent-text" className="label text-sm font-medium">
            Text to summarise
          </label>
          <span
            className={`text-xs tabular-nums ${over ? 'text-error' : 'text-muted'}`}
            aria-live="polite"
          >
            {value.text.length.toLocaleString()} / {SUMMARIZE_TEXT_MAX_CHARS.toLocaleString()}
          </span>
        </div>
        <textarea
          id="agent-text"
          className={`textarea w-full text-sm leading-relaxed ${over ? 'textarea-error' : ''}`}
          rows={10}
          placeholder="Paste the text the agent should summarise…"
          value={value.text}
          disabled={disabled}
          onChange={e => onChange({ ...value, text: e.target.value })}
          aria-invalid={over || fieldErrorFor(issues, 'text') ? true : undefined}
        />
        <FieldError message={fieldErrorFor(issues, 'text')} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="agent-style" className="label text-sm font-medium">
            Style
          </label>
          <select
            id="agent-style"
            className="select select-sm w-full"
            value={value.style}
            disabled={disabled}
            onChange={e => onChange({ ...value, style: e.target.value as Draft['style'] })}
          >
            <option value="bullets">Bullet points</option>
            <option value="paragraph">Paragraph</option>
          </select>
          <FieldError message={fieldErrorFor(issues, 'style')} />
        </div>
        <label className="label cursor-pointer justify-start gap-3 self-end">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={value.index}
            disabled={disabled}
            onChange={e => onChange({ ...value, index: e.target.checked })}
          />
          <span className="text-sm">Index the result for search</span>
        </label>
      </div>
    </div>
  )
}

export const summarizeTextForm: AgentForm<Draft> = {
  initial: INITIAL,
  schema: summarizeTextInputSchema,
  Component: SummarizeTextForm,
}
