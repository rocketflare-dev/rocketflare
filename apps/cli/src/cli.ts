#!/usr/bin/env node
/**
 * CLI entry point (D26). Wires commander to the thin command modules; the ONE place that maps
 * errors to exit codes (0 ok · 1 error · 2 not logged in · 3 forbidden) and prints them. Global
 * `--server <url>` and `--json` apply to every command. The bin name comes from `package.json`.
 */
import { Command, InvalidArgumentError } from 'commander'
import { runActivityList } from './commands/activity'
import { runConfigGet, runConfigPath, runConfigSet } from './commands/config'
import { runKeysList } from './commands/keys'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { runMembersList } from './commands/members'
import { runStatus } from './commands/status'
import { runWhoami } from './commands/whoami'
import { CONFIG_KEYS, DEFAULT_SERVER_URL, ENV } from './config'
import { type CommandContext, createContext } from './context'
import { CliError, exitCodeFor } from './errors'
import { BIN_NAME, VERSION } from './package-info'
import { createLogger } from './utils/logger'
import { formatJson } from './utils/output'

interface GlobalOptions {
  server?: string
  json?: boolean
}

const program = new Command()
program
  .name(BIN_NAME)
  .description(`Command-line interface for the ${BIN_NAME} server`)
  .version(VERSION)
  .option(
    '--server <url>',
    `server URL (default: $${ENV.url} or config, else ${DEFAULT_SERVER_URL})`
  )
  .option('--json', 'print raw JSON instead of tables', false)
  .showHelpAfterError()
  .addHelpText(
    'after',
    `
Exit codes: 0 ok · 1 error · 2 not logged in · 3 forbidden
Env:        ${ENV.apiKey} · ${ENV.url} · ${ENV.configDir} · ${ENV.debug}`
  )

/** Run a command with a context built from the global options; print + exit-code any error. */
function action(handler: (ctx: CommandContext, command: Command) => Promise<void>) {
  return async (...args: unknown[]) => {
    const command = args.at(-1) as Command
    const globals = command.optsWithGlobals<GlobalOptions>()
    let ctx: CommandContext | undefined
    try {
      ctx = await createContext({ server: globals.server, json: globals.json })
      await handler(ctx, command)
    } catch (error) {
      report(error, ctx)
      process.exitCode = exitCodeFor(error)
    }
  }
}

function report(error: unknown, ctx: CommandContext | undefined): void {
  const log = ctx?.log ?? createLogger()
  if (error instanceof CliError) {
    log.error(error.message)
    if (error.hint) log.hint(error.hint)
    if (ctx?.json) {
      const body = 'body' in error ? (error as { body?: unknown }).body : undefined
      process.stderr.write(
        `${formatJson({ error: error.message, exitCode: error.exitCode, ...(body ? { body } : {}) })}\n`
      )
    }
    return
  }
  log.error(error instanceof Error ? error.message : String(error))
  if (process.env[ENV.debug] && error instanceof Error && error.stack) log.hint(error.stack)
}

function positiveInt(label: string) {
  return (value: string) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1)
      throw new InvalidArgumentError(`${label} must be a positive integer`)
    return n
  }
}

// ---- auth ----------------------------------------------------------------------------------

program
  .command('login')
  .description('sign in through the browser and store an API key')
  .option('--server <url>', 'server URL to sign in to')
  .action(action(ctx => runLogin(ctx)))

program.command('logout').description('remove the stored API key').action(action(runLogout))

program
  .command('whoami')
  .description('show the signed-in user and tenant')
  .action(action(runWhoami))

program
  .command('status')
  .description('check the configured server health and login state')
  .action(action(runStatus))

// ---- tenant-scoped -------------------------------------------------------------------------

const members = program.command('members').description('members of the active tenant')
members
  .command('list')
  .description('list members')
  .option('--page <n>', 'page number', positiveInt('--page'))
  .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
  .action(action((ctx, cmd) => runMembersList(ctx, cmd.opts())))

const keys = program.command('keys').description('API keys of the active tenant')
keys.command('list').description('list API keys (prefixes only)').action(action(runKeysList))

const activity = program
  .command('activity')
  .description('activity log of the active tenant (admin+)')
activity
  .command('list')
  .description('list recent activity events')
  .option('--page <n>', 'page number', positiveInt('--page'))
  .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
  .option('--type <name>', 'filter by dotted event type, e.g. member.invited')
  .action(action((ctx, cmd) => runActivityList(ctx, cmd.opts())))

// ---- config --------------------------------------------------------------------------------

const config = program.command('config').description('read or edit the CLI config file')
config
  .command('get [key]')
  .description(`print the config (API key redacted); keys: ${CONFIG_KEYS.join(', ')}`)
  .action(action((ctx, cmd) => runConfigGet(ctx, cmd.args[0])))
config
  .command('set <key> <value>')
  .description('set a config value')
  .action(action((ctx, cmd) => runConfigSet(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
config.command('path').description('print the config file path').action(action(runConfigPath))

program.parseAsync(process.argv)
