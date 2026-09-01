/**
 * Branding for human output (D26): a coloured prefix derived from the package's bin name, so a
 * renamed kit gets a renamed prompt for free. Data never goes through here — only status lines.
 */
import chalk from 'chalk'
import { BIN_NAME } from '../package-info'

/** `rocketflare` in bold cyan — prepended to every human status line. */
export const PREFIX = chalk.bold.cyan(BIN_NAME)

export function brandTitle(text: string): string {
  return `${PREFIX} ${text}`
}

/** Render a command the user should run, e.g. ``run `rocketflare login` ``. */
export function cmd(args: string): string {
  return chalk.bold(`${BIN_NAME} ${args}`)
}
