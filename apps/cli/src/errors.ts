/**
 * CLI error types and the exit-code mapping (D26): 0 ok · 1 error · 2 not logged in · 3 forbidden.
 * Commands throw; `cli.ts` catches once, prints once, and sets `process.exitCode`.
 */

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_NOT_LOGGED_IN = 2
export const EXIT_FORBIDDEN = 3

export class CliError extends Error {
  readonly exitCode: number
  /** Extra dimmed line printed under the error (e.g. "run `rocketflare login`"). */
  readonly hint?: string

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CliError'
    this.exitCode = options.exitCode ?? EXIT_ERROR
    this.hint = options.hint
  }
}

export class NotLoggedInError extends CliError {
  constructor(binName: string) {
    super('Not logged in', {
      exitCode: EXIT_NOT_LOGGED_IN,
      hint: `Run \`${binName} login\` first.`,
    })
    this.name = 'NotLoggedInError'
  }
}

/** Exit code for anything a command may throw. Unknown errors → 1. */
export function exitCodeFor(error: unknown): number {
  return error instanceof CliError ? error.exitCode : EXIT_ERROR
}
