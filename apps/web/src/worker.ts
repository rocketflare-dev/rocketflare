/**
 * Cloudflare Worker entry (D5): `export default { fetch, queue, scheduled }` plus the in-script
 * Durable Object class (`NotificationsHub`, D8); Phase 3 adds
 * `export { AgentRunWorkflow } from './api/workflows/agent-run'` here — never in api/index.ts,
 * which must stay importable from Node tests.
 */
import { app } from './api/index'
import { queue } from './api/queue'
import { scheduled } from './api/scheduled'
import type { AppBindings } from './api/types'

export { NotificationsHub } from './api/durable-objects/notifications-hub'

export default {
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<AppBindings>
