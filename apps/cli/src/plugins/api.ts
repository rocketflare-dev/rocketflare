/**
 * The CLI plugin API (D31) — what a plugin's command module imports from the kit.
 *
 * The rule a plugin's CLI half keeps is the one every kit command keeps: **it owns no second copy
 * of the contract.** It calls the plugin's own routes through `requireClient(ctx).request(...)` and
 * parses the response with the same `@rocketflare/shared` schema the server validated with. It
 * builds no envelopes, constructs no URLs by hand, and never calls `fetch`.
 *
 * It also never prints an error and never calls `process.exit`. It throws `CliError`; `cli.ts`
 * catches once, prints once, and sets `process.exitCode` — which is what makes every command
 * testable in-process, and what keeps the four exit codes (0 ok · 1 error · 2 not logged in ·
 * 3 forbidden) one mapping rather than one per command.
 *
 * `process.env` is legitimate in this package — it is Node — but it is read in `config.ts` and
 * nowhere else, a plugin's commands included. Everything environmental arrives on the context.
 */

/** The only `fetch` call site. `request()` returns `{ status, raw, data }` — `raw` is what `--json` prints. */
export type { ApiClient, ApiResponse, QueryValue, RequestOptions } from '../api'
export { CliApiError, exitCodeForStatus } from '../api'
/** The per-invocation context: resolved config, output, and the injectable `fetch`/`open` seams. */
export type { CommandContext, ContextOptions, OpenLike } from '../context'
export { publicClient, requireClient } from '../context'

/** Throw these; never print. */
export {
  CliError,
  EXIT_ERROR,
  EXIT_FORBIDDEN,
  EXIT_NOT_LOGGED_IN,
  EXIT_OK,
  NotLoggedInError,
} from '../errors'

/**
 * Output helpers. Human output is chalk tables on stdout, diagnostics go to stderr, and `--json`
 * switches the whole `Output` to JSON only — so a list command pipes into `jq` without a flag per
 * command. **Never print a full API key**: prefix and four characters, as `whoami` does.
 */
export type { Column, Output } from '../utils/output'
export { formatCell, formatDate, formatJson, formatPagination, renderTable } from '../utils/output'

/** The plugin interface, and the `action()` wrapper a plugin registers with. */
export type { ActionWrapper, AnyCliPlugin, CliPlugin } from './types'
