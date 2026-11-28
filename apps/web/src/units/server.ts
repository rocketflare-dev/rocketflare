/**
 * Every unit's server half — the installed plugins, then the app's own domains — as ONE list.
 *
 * Every server registry iterates this rather than the plugin barrel: the mount table, the job
 * dispatch table, the agent, prompt and tool registries (chat, agents and MCP), crons, event
 * subscribers, email handlers, upload targets, grants, visibility, knowledge, the tenant hooks and
 * the seed. A plugin is wrapped as `kind: 'plugin'` with nothing about it changed; a domain arrives
 * already shaped by `defineDomain`. `id` is the key the namespaces — and, later, budgets, kill
 * switches and the inventory — are keyed by.
 *
 * Plugins first, so a collision the boundary check refuses resolves the way it did before domains.
 */
import { APP_DOMAINS } from '../app'
import { serverPlugins } from '../plugins/server'
import type { AnyServerPlugin, ServerUnit } from '../plugins/types'
import { liveList } from './live-list'

export type { ServerUnit } from '../plugins/types'

const wrapped = new WeakMap<AnyServerPlugin, ServerUnit>()

/** A plugin as a unit: the same object's slots, with its id lifted beside them. One per plugin. */
export function pluginUnit(plugin: AnyServerPlugin): ServerUnit {
  let unit = wrapped.get(plugin)
  if (!unit) {
    unit = { ...plugin, id: plugin.shared.id, kind: 'plugin' }
    wrapped.set(plugin, unit)
  }
  return unit
}

/** Joined on every read, never at import (`live-list.ts` says why). */
export const serverUnits: readonly ServerUnit[] = liveList(() => {
  const appDomains: readonly ServerUnit[] = APP_DOMAINS
  return [...serverPlugins.map(pluginUnit), ...appDomains]
})
