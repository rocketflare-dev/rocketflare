/**
 * Send a note to a run in flight (issue #17, decision 4).
 *
 * It is an `agent_run_events` row, so the note appears in the timeline where it happened and the
 * runtime delivers it exactly once through the `agent_run_effects` ledger — there is nothing to
 * remember on this side, and nothing to retry. A settled run is a 409, which is why this is not
 * rendered for one.
 */
import { PaperAirplaneIcon } from '@heroicons/react/24/outline'
import { STEERING_MAX_CHARS } from '@rocketflare/shared/ai/interrupts'
import { type FormEvent, useState } from 'react'
import { useSendSteering } from '@/ui/hooks/useAgents'

export function SteerComposer({ runId }: { runId: string }) {
  const send = useSendSteering(runId)
  const [text, setText] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    send.mutate(value, { onSuccess: () => setText('') })
  }

  return (
    <form className="flex items-start gap-2 pt-3" onSubmit={submit} noValidate>
      <label htmlFor="steer-note" className="sr-only">
        Send a note to the agent
      </label>
      <input
        id="steer-note"
        type="text"
        className="input input-sm flex-1"
        placeholder="Send a note to the agent…"
        value={text}
        maxLength={STEERING_MAX_CHARS}
        disabled={send.isPending}
        onChange={e => setText(e.target.value)}
      />
      <button
        type="submit"
        className="btn btn-sm btn-ghost btn-square"
        disabled={send.isPending || text.trim().length === 0}
        aria-label="Send note"
      >
        <PaperAirplaneIcon className="w-4 h-4" />
      </button>
    </form>
  )
}
