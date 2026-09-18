/**
 * Cloudflare Worker entry (D5): `export default { fetch, queue, scheduled }` plus the in-script
 * Durable Object class (`NotificationsHub`, D8) and the Workflow class (`AgentRunWorkflow`, D7).
 * The classes are exported HERE — never from api/index.ts, which must stay importable from Node
 * tests.
 *
 * The third export line is the plugin seam (D31): Cloudflare resolves a binding's `class_name`
 * against the named exports of THIS module and nowhere else, so a plugin that ships a DO or a
 * Workflow needs a line here. That line is permanent and names no plugin —
 * `plugins/worker-exports.ts` is the sixth barrel, one `export *` per installed plugin, written by
 * `pnpm plugin add` and deleted by `pnpm plugin remove`. Nothing about installing a plugin edits
 * this file.
 */
import { app } from './api/index'
import { queue } from './api/queue'
import { scheduled } from './api/scheduled'
import type { AppBindings } from './api/types'

export { NotificationsHub } from './api/durable-objects/notifications-hub'
export { AgentRunWorkflow } from './api/workflows/agent-run'
export * from './plugins/worker-exports'

export default {
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<AppBindings>
