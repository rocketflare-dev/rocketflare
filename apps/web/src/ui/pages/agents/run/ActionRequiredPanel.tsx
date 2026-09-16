/**
 * **The reason this page exists.** A run parked on a question, pinned above the timeline, because
 * somebody arriving from a notification is here to DECIDE, not to read. It unmounts the moment the
 * run is no longer `awaiting_input`.
 *
 * Five behaviours, each deliberate:
 *
 * - **The draft is validated with the ask's own shared schema first** (`interruptPayloadSchema`),
 *   the exact function the route applies — so a green client-side pass can never become a 400 — and
 *   the server's `details` map back through `fieldErrorFor` when one happens anyway.
 * - **409 is information, not an error.** Somebody else answered first, or the ask expired. The
 *   panel becomes `alert-info` — *"Someone else answered this"* — and refetches. No toast, no red.
 * - **A non-approver sees no buttons, not disabled ones.** They still see the panel, because they
 *   need to know the run is blocked and on whom; a disabled control with a tooltip is how you tell
 *   a member they are second-class.
 * - **Focus goes to the heading on mount, never to Approve.** An autofocused destructive button
 *   plus a stray Enter is how 412 subscribers get an email.
 * - **No optimistic write.** This is a decision with a side effect at the far end.
 *
 * Expiry is a pure function that also chooses its own tick rate — a naive one-second countdown on
 * a seven-day deadline would re-render this panel about 600 000 times.
 */
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import {
  type AgentRunInterrupt,
  INTERRUPT_NOTE_MAX_CHARS,
  interruptPayloadSchema,
  rejectionFor,
} from '@rocketflare/shared/ai/interrupts'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { isInterruptNotPending, useResolveInterrupt } from '@/ui/hooks/useAgents'
import { type Issue, issuesFrom } from '../issues'
import { expiryState } from './interrupts/expiry'
import {
  type AnswerDraft,
  EMPTY_DRAFT,
  InterruptFields,
  OTHER_VALUE,
} from './interrupts/InterruptFields'

/** The body the route receives for a `resolved` answer to this ask. */
function payloadFor(interrupt: AgentRunInterrupt, draft: AnswerDraft): unknown {
  const note = draft.note.trim() ? { note: draft.note.trim() } : {}
  switch (interrupt.spec.kind) {
    case 'approval': {
      if (draft.editedInput === null) return note
      // A parse failure is reported as an issue on the field rather than posted as a string.
      try {
        return { ...note, editedInput: JSON.parse(draft.editedInput) as unknown }
      } catch {
        return { ...note, editedInput: draft.editedInput }
      }
    }
    case 'choice':
      return { ...note, value: draft.value === OTHER_VALUE ? draft.other : draft.value }
    case 'input':
      return { ...note, text: draft.text }
    case 'form':
      return { ...note, values: draft.values }
  }
}

function editedInputIssue(draft: AnswerDraft): Issue | null {
  if (draft.editedInput === null) return null
  try {
    JSON.parse(draft.editedInput)
    return null
  } catch {
    return { path: ['editedInput'], message: 'The edited input must be valid JSON' }
  }
}

export function ActionRequiredPanel({
  runId,
  interrupt,
  canAnswer,
  approverLabel,
}: {
  runId: string
  interrupt: AgentRunInterrupt
  /** Whether THIS person may answer — the agent's `approvers` policy, decided server-side. */
  canAnswer: boolean
  /** Who is expected to answer when the reader may not: "an administrator". */
  approverLabel: string
}) {
  const resolve = useResolveInterrupt(runId)
  const [draft, setDraft] = useState<AnswerDraft>(EMPTY_DRAFT)
  const [issues, setIssues] = useState<readonly Issue[] | undefined>()
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  const spec = interrupt.spec
  const rejection = rejectionFor(spec)
  const taken = isInterruptNotPending(resolve.error)

  // The heading, never a button: this panel arrives under somebody's cursor and Enter must not be
  // an approval.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // A fresh ask is a fresh draft; the id is the identity, not the object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ask, not its contents
  useEffect(() => {
    setDraft(EMPTY_DRAFT)
    setIssues(undefined)
  }, [interrupt.id])

  const expiry = useExpiry(interrupt.expiresAt)

  const submit = (status: 'resolved' | 'cancelled') => (event: FormEvent) => {
    event.preventDefault()
    if (status === 'cancelled') {
      const note = draft.note.trim()
      resolve.mutate({ interruptId: interrupt.id, status, payload: note ? { note } : {} })
      return
    }
    const bad = editedInputIssue(draft)
    if (bad) return setIssues([bad])
    const payload = payloadFor(interrupt, draft)
    const parsed = interruptPayloadSchema(spec).safeParse(payload)
    if (!parsed.success) return setIssues(parsed.error.issues as Issue[])
    setIssues(undefined)
    resolve.mutate(
      { interruptId: interrupt.id, status, payload },
      { onError: error => setIssues(issuesFrom(error)) }
    )
  }

  if (taken) {
    return (
      <section className="alert alert-info text-sm" aria-live="polite" aria-label="Action required">
        <span>
          <strong>Someone else answered this.</strong> The run has already moved on — the timeline
          below shows what was decided.
        </span>
      </section>
    )
  }

  const title = spec.title ?? 'Action required'

  return (
    <section
      className="surface-panel border-l-4 border-l-warning"
      aria-live="polite"
      aria-label="Action required"
    >
      <div className="flex items-start gap-2.5">
        <ExclamationTriangleIcon className="w-5 h-5 shrink-0 text-warning mt-0.5" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            {/* `tabIndex={-1}` so it can hold focus without becoming a tab stop. */}
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
              {title}
            </h2>
            {expiry && (
              <span className={`text-xs ${expiry.urgent ? 'text-error' : 'text-muted'}`}>
                {expiry.label}
              </span>
            )}
          </div>
          <p className="text-sm text-secondary whitespace-pre-wrap">{spec.message}</p>

          {!canAnswer ? (
            <p className="text-sm text-muted">Waiting for {approverLabel} to answer.</p>
          ) : (
            <form className="space-y-3" onSubmit={submit('resolved')} noValidate>
              <InterruptFields
                spec={spec}
                draft={draft}
                onChange={setDraft}
                issues={issues}
                disabled={resolve.isPending}
              />
              <details>
                <summary className="cursor-pointer text-xs text-muted select-none">
                  Add a note
                </summary>
                <label htmlFor="interrupt-note" className="sr-only">
                  Note
                </label>
                <textarea
                  id="interrupt-note"
                  className="textarea w-full text-sm mt-1"
                  rows={2}
                  maxLength={INTERRUPT_NOTE_MAX_CHARS}
                  value={draft.note}
                  disabled={resolve.isPending}
                  placeholder="Why — recorded with the answer and shown to the agent."
                  onChange={e => setDraft({ ...draft, note: e.target.value })}
                />
              </details>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={resolve.isPending}
                >
                  {spec.kind === 'approval' ? (spec.confirmLabel ?? 'Approve') : 'Send answer'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={resolve.isPending}
                  onClick={submit('cancelled')}
                >
                  {spec.kind === 'approval' ? (spec.rejectLabel ?? 'Reject') : 'Decline'}
                </button>
                <span className="text-xs text-muted">
                  {rejection === 'cancel_run'
                    ? 'Declining stops the run.'
                    : 'Declining goes back to the agent, which may try another way.'}
                </span>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * Re-read the clock at the rate `expiryState` asks for — a second under an hour, a minute under a
 * day, and **no timer at all** beyond that.
 */
function useExpiry(expiresAt: Date | null) {
  const [now, setNow] = useState(() => new Date())
  const state = useMemo(() => expiryState(expiresAt, now), [expiresAt, now])
  const tickMs = state?.tickMs ?? null
  useEffect(() => {
    if (tickMs === null) return
    const timer = setInterval(() => setNow(new Date()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])
  return state
}
