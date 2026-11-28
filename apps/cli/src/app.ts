/**
 * The app's own domains, CLI half — ONE line per domain that ships commands, written by hand. Each
 * entry is a domain's `apps/cli/src/<id>/index.ts`, the same `CliPlugin` shape a plugin's commands
 * take, registered after the built-in commands and the plugins' (docs/CONCEPTS.md §20). App-owned:
 * `kit:upgrade` never writes to it beyond creating it, empty, where it is missing.
 */
import { exampleSalesCli } from './example-sales'
import type { AnyCliPlugin } from './plugins/types'

export const APP_COMMANDS = [exampleSalesCli] as const satisfies readonly AnyCliPlugin[]
