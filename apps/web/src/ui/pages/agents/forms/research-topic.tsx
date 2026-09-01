/**
 * Input form for the `research-topic` agent (D7, D18): one question, counted against
 * `RESEARCH_TOPIC_MAX_CHARS`. The agent decides how many searches it needs, so there is nothing
 * else to set; validated with the SAME `researchTopicInputSchema` the route and the runtime apply.
 */
import { RESEARCH_TOPIC_MAX_CHARS, researchTopicInputSchema } from '@rocketflare/shared/ai/agents'
import { FieldError, fieldErrorFor } from '@/ui/components/shared'
import type { AgentForm, AgentFormProps } from './types'

type Draft = { topic: string }

const INITIAL: Draft = { topic: '' }

function ResearchTopicForm({ value, onChange, issues, disabled }: AgentFormProps<Draft>) {
  const over = value.topic.length > RESEARCH_TOPIC_MAX_CHARS
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor="agent-topic" className="label text-sm font-medium">
          What should the agent research?
        </label>
        <span
          className={`text-xs tabular-nums ${over ? 'text-error' : 'text-muted'}`}
          aria-live="polite"
        >
          {value.topic.length.toLocaleString()} / {RESEARCH_TOPIC_MAX_CHARS.toLocaleString()}
        </span>
      </div>
      <textarea
        id="agent-topic"
        className={`textarea w-full text-sm leading-relaxed ${over ? 'textarea-error' : ''}`}
        rows={5}
        placeholder="e.g. What does our onboarding material say about access requests?"
        value={value.topic}
        disabled={disabled}
        onChange={e => onChange({ topic: e.target.value })}
        aria-invalid={over || fieldErrorFor(issues, 'topic') ? true : undefined}
      />
      <FieldError message={fieldErrorFor(issues, 'topic')} />
      <p className="text-xs text-muted mt-1">
        The agent answers from this workspace's knowledge base only, citing the documents it used.
      </p>
    </div>
  )
}

export const researchTopicForm: AgentForm<Draft> = {
  initial: INITIAL,
  schema: researchTopicInputSchema,
  Component: ResearchTopicForm,
}
