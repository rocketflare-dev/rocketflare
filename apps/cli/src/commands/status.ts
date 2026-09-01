/** `rocketflare status` — `GET /api/health` on the configured server plus the local login state (D26). */
import chalk from 'chalk'
import { z } from 'zod'
import { redactKey } from '../config'
import { type CommandContext, publicClient } from '../context'

export const healthSchema = z
  .object({ status: z.string(), version: z.string().optional(), env: z.string().optional() })
  .passthrough()

export async function runStatus(ctx: CommandContext): Promise<void> {
  const { data, raw } = await publicClient(ctx).request('GET', '/api/health', {
    schema: healthSchema,
  })
  const loggedIn = Boolean(ctx.config.apiKey)
  ctx.out.data(
    {
      serverUrl: ctx.config.serverUrl,
      health: raw,
      loggedIn,
      tenantName: ctx.config.tenantName,
      user: ctx.config.user,
      apiKey: redactKey(ctx.config.apiKey),
    },
    () =>
      [
        `${chalk.bold('Server:')}  ${ctx.config.serverUrl} ${chalk.dim(`(from ${ctx.config.serverUrlSource})`)}`,
        `${chalk.bold('Health:')}  ${data.status === 'ok' ? chalk.green(data.status) : chalk.yellow(data.status)}${data.version ? ` · v${data.version}` : ''}${data.env ? ` · ${data.env}` : ''}`,
        `${chalk.bold('Login:')}   ${
          loggedIn
            ? `${chalk.green('signed in')}${ctx.config.user?.email ? ` as ${ctx.config.user.email}` : ''}${ctx.config.tenantName ? ` · ${ctx.config.tenantName}` : ''} ${chalk.dim(`(key ${redactKey(ctx.config.apiKey)} from ${ctx.config.apiKeySource})`)}`
            : `${chalk.yellow('not signed in')} ${chalk.dim(`— run \`${ctx.binName} login\``)}`
        }`,
      ].join('\n')
  )
}
