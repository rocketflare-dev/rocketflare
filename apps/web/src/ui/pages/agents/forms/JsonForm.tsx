/**
 * Fallback input form (D7): a raw JSON textarea for an agent with no dedicated form. The server
 * validates the parsed body with the agent's own `inputSchema`.
 */
import { FieldError, fieldErrorFor } from '@/ui/components/shared'
import type { AgentFormProps } from './types'

export function JsonForm({ value, onChange, issues, disabled }: AgentFormProps<string>) {
  // The fallback schema reports its parse failure at the root path.
  const rootIssue = issues?.find(i => i.path.length === 0)?.message
  return (
    <div>
      <label htmlFor="agent-json" className="label text-sm font-medium">
        Input (JSON)
      </label>
      <textarea
        id="agent-json"
        className={`textarea w-full font-mono text-xs leading-relaxed ${rootIssue ? 'textarea-error' : ''}`}
        rows={10}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        aria-invalid={rootIssue ? true : undefined}
        spellCheck={false}
      />
      <FieldError message={rootIssue ?? fieldErrorFor(issues, 'input')} />
      <p className="text-xs text-muted mt-1">
        This agent has no form yet; the server validates the JSON against its input schema.
      </p>
    </div>
  )
}
