/**
 * The run's input, ABOVE the two columns and above the fold — one home, not a tab.
 *
 * It used to be `?tab=input`, a `<pre>` of the validated body four clicks away from the thing it
 * explains. "What was it asked?" is the first question anybody has about a run they did not start,
 * and two homes for one fact is the trap this feature avoids everywhere else (an interrupt appears
 * pinned *and* inline, but the FORM exists only in the pinned copy).
 *
 * Everything it decides is `summariseInput` (pure, tested); this file is markup, truncation and the
 * one toggle. A long value — `research-topic`'s question, `summarize-text`'s whole document — is
 * clipped with a per-value "Show more" rather than scrolled, because the common case is one long
 * value and one short one, and a scrollbar around a paragraph reads as an accident.
 */
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import type { JsonSchema } from '@rocketflare/shared/ai/interrupts'
import { useMemo, useState } from 'react'
import { INPUT_VALUE_PREVIEW_CHARS, type InputValue, summariseInput } from './inputSummary'

export function RunInputSummary({
  input,
  schema,
}: {
  input: unknown
  /** The agent's own `inputJsonSchema`; absent (or out of the closed set) → the JSON fallback. */
  schema?: JsonSchema | null
}) {
  const summary = useMemo(() => summariseInput(input, schema), [input, schema])
  if (summary.kind === 'empty') return null

  return (
    <section className="surface-panel px-4 py-3" aria-label="Run input">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Input</h2>
      {summary.kind === 'fields' ? (
        <dl className="grid grid-cols-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {summary.values.map(value => (
            <InputRow key={value.name} value={value} />
          ))}
        </dl>
      ) : (
        <JsonBlock text={summary.text} />
      )}
    </section>
  )
}

function InputRow({ value }: { value: InputValue }) {
  const [open, setOpen] = useState(false)
  const shown =
    value.long && !open ? `${value.text.slice(0, INPUT_VALUE_PREVIEW_CHARS)}…` : value.text
  return (
    <>
      <dt className="text-xs text-muted sm:py-0.5">{value.label}</dt>
      <dd className="min-w-0 break-words whitespace-pre-wrap mb-1 sm:mb-0">
        {shown}
        {value.long && (
          <button
            type="button"
            className="btn btn-ghost btn-xs ml-1 align-baseline"
            aria-expanded={open}
            onClick={() => setOpen(previous => !previous)}
          >
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </dd>
    </>
  )
}

/** The whole-input fallback: a schema we cannot label, or an input carrying keys it never declared. */
function JsonBlock({ text }: { text: string }) {
  const long = text.length > INPUT_VALUE_PREVIEW_CHARS
  const [open, setOpen] = useState(!long)
  return (
    <div>
      <pre className="surface-inset rounded-lg p-3 text-xs whitespace-pre-wrap break-words max-h-[24rem] overflow-auto">
        {open ? text : `${text.slice(0, INPUT_VALUE_PREVIEW_CHARS)}…`}
      </pre>
      {long && (
        <button
          type="button"
          className="btn btn-ghost btn-xs mt-1 gap-1"
          aria-expanded={open}
          onClick={() => setOpen(previous => !previous)}
        >
          {open ? (
            <ChevronDownIcon className="w-3.5 h-3.5" />
          ) : (
            <ChevronRightIcon className="w-3.5 h-3.5" />
          )}
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
