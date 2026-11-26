/**
 * A first message handed to Chat from elsewhere (Home's composer): the sender creates the
 * conversation, then navigates to it with `chatHandOverState(message)` as router state, and the
 * chat page sends it once the thread has loaded (`useHandOverMessage`). Router state, not `?q=`:
 * a message never lands in the address bar, the history or a server log, and the state is cleared
 * as it is sent, so a reload or Back never sends it twice.
 */
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

const KEY = 'chatHandOver'

export function chatHandOverState(message: string): Record<string, string> {
  return { [KEY]: message }
}

/** The handed-over message in a router state, if there is one. Pure. */
export function readHandOver(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const value = (state as Record<string, unknown>)[KEY]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Send the handed-over message once `ready` (the thread loaded, nothing streaming). */
export function useHandOverMessage(
  conversationId: string | undefined,
  ready: boolean,
  send: (content: string) => void
): void {
  const location = useLocation()
  const navigate = useNavigate()
  const sentFor = useRef<string | null>(null)
  const message = readHandOver(location.state)

  useEffect(() => {
    if (!conversationId || !ready || !message || sentFor.current === conversationId) return
    sentFor.current = conversationId
    navigate(location.pathname, { replace: true, state: null })
    send(message)
  }, [conversationId, ready, message, send, navigate, location.pathname])
}
