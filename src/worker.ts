/**
 * Cloudflare Worker entry (D5): `export default { fetch, queue, scheduled }`. Phase 2/3 add
 * `export { NotificationsHub } from './api/durable-objects/notifications-hub'` and
 * `export { AgentRunWorkflow } from './api/workflows/agent-run'` here — never in api/index.ts,
 * which must stay importable from Node tests.
 */
import { app } from './api/index'
import { queue } from './api/queue'
import { scheduled } from './api/scheduled'
import type { AppBindings } from './api/types'

export default {
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<AppBindings>
