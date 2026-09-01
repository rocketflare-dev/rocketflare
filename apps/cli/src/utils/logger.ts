/**
 * Status logger (D26). Everything here goes to STDERR so `--json` stdout stays pipe-clean.
 * `debug` lines appear only when `GMGO_DEBUG` is set (ADAPTING renames the prefix).
 */
import chalk from 'chalk'
import { PREFIX } from './brand'

export interface Logger {
  info(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  /** Secondary guidance under an info/error line, dimmed. */
  hint(message: string): void
  debug(message: string): void
}

export interface LoggerOptions {
  write?: (line: string) => void
  debug?: boolean
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  const debugEnabled = options.debug ?? false
  return {
    info: message => write(`${PREFIX} ${message}`),
    success: message => write(`${PREFIX} ${chalk.green('✓')} ${message}`),
    warn: message => write(`${PREFIX} ${chalk.yellow('!')} ${message}`),
    error: message => write(`${PREFIX} ${chalk.red('✗')} ${message}`),
    hint: message => write(chalk.dim(`  ${message}`)),
    debug: message => {
      if (debugEnabled) write(chalk.dim(`[debug] ${message}`))
    },
  }
}

/** A logger that records lines instead of printing — for tests. */
export function createMemoryLogger(debug = false): Logger & { lines: string[] } {
  const lines: string[] = []
  const logger = createLogger({ write: line => lines.push(line), debug })
  return Object.assign(logger, { lines })
}
