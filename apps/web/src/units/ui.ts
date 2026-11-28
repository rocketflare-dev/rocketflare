/**
 * Every unit's UI half — the installed plugins, then the app's own domains — as ONE list, read by
 * `App.tsx` (routes), `SideNav` (nav groups), Home (links and cards), the header slots, settings
 * tabs, `queryKeys` and the agent forms. The UI twin of `units/server.ts`; it imports UI halves
 * only, so it is safe in the main bundle exactly as the plugin UI barrel is.
 */
import { APP_DOMAIN_UIS } from '../app-ui'
import type { AnyUiPlugin, UiUnit } from '../plugins/types'
import { uiPlugins } from '../plugins/ui'
import { liveList } from './live-list'

export type { UiUnit } from '../plugins/types'

const wrapped = new WeakMap<AnyUiPlugin, UiUnit>()

export function pluginUiUnit(plugin: AnyUiPlugin): UiUnit {
  let unit = wrapped.get(plugin)
  if (!unit) {
    unit = { ...plugin, id: plugin.shared.id, kind: 'plugin' }
    wrapped.set(plugin, unit)
  }
  return unit
}

/** Joined on every read, like `serverUnits` (`live-list.ts` says why). */
export const uiUnits: readonly UiUnit[] = liveList(() => {
  const appDomainUis: readonly UiUnit[] = APP_DOMAIN_UIS
  return [...uiPlugins.map(pluginUiUnit), ...appDomainUis]
})
