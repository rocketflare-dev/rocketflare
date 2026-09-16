/**
 * How long is left to answer, and **how often the panel should re-render to say so**.
 *
 * The second half is the whole point. `AGENT_INTERRUPT_TIMEOUT` is measured in days, so a naive
 * one-second countdown on a seven-day deadline re-renders the action panel about 600 000 times to
 * change a number nobody is watching. `tickMs` is therefore chosen from the distance: a second
 * under an hour, a minute under a day, and **`null` beyond that** — past a day the phrase does not
 * change often enough to be worth a timer at all, and the page re-renders on the next fetch anyway.
 *
 * Pure: it takes `now`, so the tests state a clock instead of mocking one.
 */

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface ExpiryState {
  /** Milliseconds left; negative once it has passed. */
  remainingMs: number
  expired: boolean
  /** "expires in 6 days", "expires in 4 minutes", "expired". */
  label: string
  /** How often to re-read the clock, or `null` when a timer is not worth running. */
  tickMs: number | null
  /** Under an hour: worth saying loudly. */
  urgent: boolean
}

function humanise(ms: number): string {
  if (ms >= DAY) {
    const days = Math.round(ms / DAY)
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (ms >= HOUR) {
    const hours = Math.round(ms / HOUR)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  if (ms >= MINUTE) {
    const minutes = Math.round(ms / MINUTE)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const seconds = Math.max(1, Math.round(ms / SECOND))
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

export function expiryState(expiresAt: Date | null | undefined, now: Date): ExpiryState | null {
  if (!expiresAt) return null
  const remainingMs = expiresAt.getTime() - now.getTime()
  if (remainingMs <= 0) {
    return { remainingMs, expired: true, label: 'expired', tickMs: null, urgent: true }
  }
  return {
    remainingMs,
    expired: false,
    label: `expires in ${humanise(remainingMs)}`,
    tickMs: remainingMs < HOUR ? SECOND : remainingMs < DAY ? MINUTE : null,
    urgent: remainingMs < HOUR,
  }
}
