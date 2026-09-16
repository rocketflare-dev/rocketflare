/**
 * The CLI plugin barrel (D31) — ONE line per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     import { approvalsCli } from './approvals'
 *     export const CLI_PLUGINS = [approvalsCli] as const satisfies readonly AnyCliPlugin[]
 *
 * `cli.ts` loops over `cliPlugins` and calls `register(program, action)` once each, after the kit's
 * own commands, so `rocketflare --help` lists them together.
 */
import { exampleFeatureCli } from './example-feature'
import type { AnyCliPlugin } from './types'

export const CLI_PLUGINS = [exampleFeatureCli] as const satisfies readonly AnyCliPlugin[]

/** The barrel as a plain list. Iterate this; `CLI_PLUGINS` is for type derivation. */
export const cliPlugins: readonly AnyCliPlugin[] = CLI_PLUGINS

export type { ActionWrapper, AnyCliPlugin, CliPlugin } from './types'
