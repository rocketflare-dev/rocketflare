/**
 * THE APP'S OWN event handlers (D42) — the place a copy's own code subscribes to a plugin's events,
 * the way a plugin does through `ServerPlugin.eventHandlers`. The kit ships it empty and never
 * edits it again, so `kit:upgrade` treats it as `manual` (`.rocketflare.json`): a later kit
 * release cannot overwrite what you add here.
 *
 *     import { eventCtx } from '../../../plugins/api'
 *     export const APP_EVENT_HANDLERS: readonly EventHandler[] = [
 *       {
 *         event: 'sites.form.submitted',
 *         name: 'notify-sales',
 *         handle: async (event, ctx) => {
 *           await eventCtx(ctx).enqueue({ type: 'email.send', payload: { … } })
 *         },
 *       },
 *     ]
 *
 * Each entry gets its own queued delivery per event (`app:<name>` in the job), so one failing
 * handler retries alone. `name` is unique in this list; `event` must be one an installed plugin
 * declares (`tests/config/plugins.test.ts` refuses an undeclared one). A handler is a job: await
 * everything, throw to retry, be idempotent on `event.id`.
 */
import type { EventHandler } from './types'

export const APP_EVENT_HANDLERS: readonly EventHandler[] = []
