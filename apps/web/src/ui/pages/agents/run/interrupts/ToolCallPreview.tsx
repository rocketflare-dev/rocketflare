/**
 * The tool call an `approval` ask is gating: its name, its arguments, and — only when the ask says
 * `allowEdits` — a box to change them before approving.
 *
 * Editing is off by default and the SERVER re-validates an edit against the tool's stored JSON
 * Schema, because *a client that can edit tool arguments is a client that can call anything*. The
 * textarea is therefore a convenience over a body the route will check, never the check itself.
 */
import type { ApprovalTool } from '@rocketflare/shared/ai/interrupts'
import { FieldError } from '@/ui/components/shared'
import { humaniseToolName } from '../timeline/timelineModel'
import { pretty } from '../timeline/toolResults'

export function ToolCallPreview({
  tool,
  edited,
  onEdit,
  error,
  disabled,
}: {
  tool: ApprovalTool
  /** The raw JSON text of an edit in progress; `null` while the original stands. */
  edited: string | null
  onEdit: (value: string | null) => void
  error?: string
  disabled?: boolean
}) {
  return (
    <div className="surface-inset rounded-md p-2.5 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{humaniseToolName(tool.name)}</span>
        {tool.allowEdits && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={disabled}
            onClick={() => onEdit(edited === null ? pretty(tool.input) : null)}
          >
            {edited === null ? 'Edit input' : 'Use the original'}
          </button>
        )}
      </div>
      {edited === null ? (
        <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">
          {pretty(tool.input)}
        </pre>
      ) : (
        <div>
          <label htmlFor="interrupt-edited-input" className="sr-only">
            Edited tool input (JSON)
          </label>
          <textarea
            id="interrupt-edited-input"
            className={`textarea w-full font-mono text-xs leading-relaxed ${error ? 'textarea-error' : ''}`}
            rows={8}
            value={edited}
            disabled={disabled}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={e => onEdit(e.target.value)}
          />
          <FieldError message={error} />
        </div>
      )}
    </div>
  )
}
