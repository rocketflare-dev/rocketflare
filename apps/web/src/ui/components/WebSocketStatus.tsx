/**
 * Header dot for the realtime connection (D8): green when open, amber while connecting, grey when
 * closed. Reads the websocket store only; the label doubles as the accessible name.
 */
import { type WebSocketStatus as Status, useWebSocketStore } from '@/ui/stores/websocketStore'

const LABEL: Record<Status, string> = {
  open: 'Realtime connected',
  connecting: 'Realtime connecting',
  closed: 'Realtime offline',
}

// Literal class strings (not built from data) so the Tailwind source scan emits them.
const TONE: Record<Status, string> = {
  open: 'bg-success',
  connecting: 'bg-warning',
  closed: 'bg-base-300',
}

export function WebSocketStatus() {
  const status = useWebSocketStore(s => s.status)
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6"
      role="status"
      aria-label={LABEL[status]}
      title={LABEL[status]}
      data-status={status}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${TONE[status]}`} />
    </span>
  )
}

export default WebSocketStatus
