/**
 * The shared plugin barrel (D31) — ONE line per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     import { approvalsShared } from './approvals'
 *     export const SHARED_PLUGINS = [approvalsShared] as const satisfies readonly SharedPlugin[]
 *
 * `SHARED_PLUGINS` is an `as const` TUPLE because the composers derive types from it (A2: the job
 * variant union, the agent-key enum, the subject union). `sharedPlugins` beside it is the same
 * list widened for iteration — an EMPTY tuple indexes to `never`, and `never.id` is a type error,
 * so every consumer that only wants to loop reads the widened one.
 */
import type { SharedPlugin } from './types'

export const SHARED_PLUGINS = [] as const satisfies readonly SharedPlugin[]

/** The barrel as a plain list. Iterate this; `SHARED_PLUGINS` is for type derivation. */
export const sharedPlugins: readonly SharedPlugin[] = SHARED_PLUGINS

export type { SharedPlugin } from './types'
export { isPluginId, PLUGIN_ID_RE, pluginNamespace } from './types'
