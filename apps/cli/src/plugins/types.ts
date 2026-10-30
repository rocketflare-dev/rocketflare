/**
 * The CLI half of a plugin.
 *
 * A plugin that ships commands registers them on the CLI's `program` with the same `action()`
 * wrapper every built-in command uses, so it inherits one context, one error printer and one exit-code
 * mapping (0 ok · 1 error · 2 not logged in · 3 forbidden). It never calls `fetch` itself and never
 * prints an error: it throws `CliError`, exactly like `commands/*.ts`.
 */

import type { SharedPlugin } from '@rocketflare/shared/plugins'
import type { Command } from 'commander'
import type { CommandContext } from '../context'

/** `action()` in `cli.ts`: builds the context from the global options and maps any error. */
export type ActionWrapper = (
  handler: (ctx: CommandContext, command: Command) => Promise<void>
) => (...args: unknown[]) => Promise<void>

export interface CliPlugin<S extends SharedPlugin = SharedPlugin> {
  shared: S
  /** Add `program.command(...)` entries. The top-level command name is the plugin's id. */
  register(program: Command, action: ActionWrapper): void
}

export type AnyCliPlugin = CliPlugin<SharedPlugin>
