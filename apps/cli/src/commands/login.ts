/** `rocketflare login [--server <url>]` — browser handoff → API key in config (D26). */
import { loginFlow } from '../auth'
import type { CommandContext } from '../context'

export async function runLogin(ctx: CommandContext): Promise<void> {
  const result = await loginFlow({
    serverUrl: ctx.config.serverUrl,
    store: ctx.store,
    log: ctx.log,
    open: ctx.open,
    fetch: ctx.fetch,
  })
  if (ctx.json) ctx.out.data(result, () => '')
}
