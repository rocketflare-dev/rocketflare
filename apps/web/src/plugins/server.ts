/**
 * The server plugin barrel (D31) — ONE line per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     import { approvalsServer } from './approvals'
 *     export const SERVER_PLUGINS = [approvalsServer] as const satisfies readonly AnyServerPlugin[]
 *
 * Read by `api/index.ts` (mounts), `utils/routes/api-prefixes.ts`, `utils/db/tenant-helpers.ts`,
 * `services/access.ts`, `services/groups.ts` and `scripts/seed.ts` — and, once A2 lands, by the
 * jobs, agents, prompts, permissions and scheduled registries too.
 *
 * `SERVER_PLUGINS` is an `as const` TUPLE so those type-level derivations can read it; an EMPTY
 * tuple indexes to `never`, and `never.mounts` is a type error, so everything that only iterates
 * reads the widened `serverPlugins` beside it.
 */
import { exampleFeatureServer } from './example-feature'
import type { AnyServerPlugin } from './types'

export const SERVER_PLUGINS = [exampleFeatureServer] as const satisfies readonly AnyServerPlugin[]

/** The barrel as a plain list. Iterate this; `SERVER_PLUGINS` is for type derivation. */
export const serverPlugins: readonly AnyServerPlugin[] = SERVER_PLUGINS

export type { AnyServerPlugin, ServerPlugin } from './types'
