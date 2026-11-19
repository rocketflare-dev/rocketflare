/**
 * Cancel that reaches the call in flight. `checkCancelled()` is a poll an agent makes between
 * turns; nothing polls inside a model call that takes a minute. So each `execute` attempt also
 * watches the row (`watchCancel`) and, the moment a cancel is requested, aborts the attempt's
 * signal — `ctx.signal`, and every call through `ctx.chat.client`, which `abortableChatClient`
 * hands that signal and races against it (a Workers AI call cannot be aborted, so the race is
 * what stops waiting for it). The runtime reads an aborted signal as a cancel, never as a
 * retryable provider failure.
 *
 * What it costs: one indexed read of the run row every `CANCEL_POLL_MS` while an attempt runs. A
 * call abandoned mid-flight may still be billed by the provider without an `ai_usage` row — the
 * usage never came back to record.
 */

import type { Logger } from '../../utils/core/logger'
import type { ChatClient, ChatParams } from '../ai/types'
import { AgentCancelledError } from './runs'

/** How often a running attempt reads its own row for a cancel. */
export const CANCEL_POLL_MS = 3000

export interface CancelWatch {
  /** Aborted (with an `AgentCancelledError` reason) once a cancel is seen. */
  signal: AbortSignal
  /** Stop polling. Always call it — in `finally` — or the timer outlives the step. */
  stop(): void
}

/**
 * Poll `isRequested` every `intervalMs` until it says yes (abort) or `stop()`. Overlapping polls
 * are skipped, and a failed poll is logged and retried next tick: a database blip must not read
 * as a cancel, and must not kill the attempt either.
 */
export function watchCancel(
  isRequested: () => Promise<boolean>,
  options: { intervalMs?: number; logger?: Logger } = {}
): CancelWatch {
  const controller = new AbortController()
  let polling = false
  const timer = setInterval(async () => {
    if (polling || controller.signal.aborted) return
    polling = true
    try {
      if (await isRequested()) {
        clearInterval(timer)
        controller.abort(new AgentCancelledError())
      }
    } catch (err) {
      options.logger?.warn({ err }, 'agent-run: cancel poll failed; will retry')
    } finally {
      polling = false
    }
  }, options.intervalMs ?? CANCEL_POLL_MS)
  return { signal: controller.signal, stop: () => clearInterval(timer) }
}

function cancelled(signal: AbortSignal): AgentCancelledError {
  return signal.reason instanceof AgentCancelledError ? signal.reason : new AgentCancelledError()
}

/** Reject as soon as `signal` aborts, whatever `work` is doing. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.aborted ? cancelled(signal) : err)
      }
    )
  })
}

function withSignal(params: ChatParams, signal: AbortSignal): ChatParams {
  return { ...params, signal: params.signal ? AbortSignal.any([params.signal, signal]) : signal }
}

/**
 * `client` with `signal` on every call, and every call raced against it: an aborted signal
 * rejects with `AgentCancelledError` at once, even from a provider that ignores the signal.
 */
export function abortableChatClient(client: ChatClient, signal: AbortSignal): ChatClient {
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    complete: params => raceAbort(client.complete(withSignal(params, signal)), signal),
    async *stream(params) {
      if (signal.aborted) throw cancelled(signal)
      const iterator = client.stream(withSignal(params, signal))[Symbol.asyncIterator]()
      while (true) {
        const next = await raceAbort(iterator.next(), signal)
        if (next.done) return
        yield next.value
      }
    },
  }
}
