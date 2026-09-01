/** `gmgo whoami` — who the stored key belongs to (`/api/me`) and its tenant (`/api/tenant`) (D26). */
import chalk from 'chalk'
import { whoAmI } from '../auth'
import { redactKey } from '../config'
import { type CommandContext, requireClient } from '../context'

export async function runWhoami(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { user, tenant, raw } = await whoAmI(client)
  const tenantName = tenant?.name ?? ctx.config.tenantName
  const tenantId = tenant?.id ?? ctx.config.tenantId
  ctx.out.data(
    {
      user: raw.me,
      tenant: raw.tenant,
      serverUrl: ctx.config.serverUrl,
      apiKey: redactKey(ctx.config.apiKey),
      apiKeySource: ctx.config.apiKeySource,
    },
    () =>
      [
        `${chalk.bold('User:')}    ${user.name ?? '-'} <${user.email ?? '-'}>${user.isGlobalAdmin ? chalk.magenta(' (global admin)') : ''}`,
        `${chalk.bold('Tenant:')}  ${tenantName ?? '-'}${tenantId ? chalk.dim(` (${tenantId})`) : ''}`,
        `${chalk.bold('Server:')}  ${ctx.config.serverUrl}`,
        `${chalk.bold('API key:')} ${redactKey(ctx.config.apiKey)} ${chalk.dim(`(from ${ctx.config.apiKeySource})`)}`,
      ].join('\n')
  )
}
