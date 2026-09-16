/**
 * The UI plugin barrel (D31) — ONE line per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     import { approvalsUi } from './approvals/ui'
 *     export const UI_PLUGINS = [approvalsUi] as const satisfies readonly AnyUiPlugin[]
 *
 * Read by `App.tsx` (routes, per tier), `components/SideNav.tsx` (nav groups),
 * `pages/settings/SettingsLayout.tsx` (tabs) and `lib/query-keys.ts`.
 *
 * A plugin's pages arrive as `lazy(() => import(...))`, so importing this barrel from the eager
 * shell costs the lazy wrapper and nothing else — `tests/config/plugins.test.ts` checks the source
 * of every plugin `ui.ts` for exactly that.
 */
import type { AnyUiPlugin } from './types'

export const UI_PLUGINS = [] as const satisfies readonly AnyUiPlugin[]

/** The barrel as a plain list. Iterate this; `UI_PLUGINS` is for type derivation. */
export const uiPlugins: readonly AnyUiPlugin[] = UI_PLUGINS

export type { AnyUiPlugin, UiPlugin } from './types'
