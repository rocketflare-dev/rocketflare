/** `gmgo logout` — drop the stored API key, tenant and user; keep the server URL (D26). */
import { logoutFlow } from '../auth'
import type { CommandContext } from '../context'

export async function runLogout(ctx: CommandContext): Promise<void> {
  await logoutFlow({ store: ctx.store, log: ctx.log })
}
