/**
 * `rocketflare features list` (D30) — `GET /api/features`, any member.
 *
 * The EFFECTIVE flags for the key's organisation, not the platform rollout state. Administering a
 * flag is a global-admin act and `/api/admin/*` resolves the session cookie only, so a tenant API
 * key cannot reach it — by design, and not something to work around here.
 */
import { effectiveFeaturesResponseSchema } from '@rocketflare/shared/features'
import { type CommandContext, requireClient } from '../context'
import { renderTable } from '../utils/output'

export async function runFeaturesList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/features', {
    schema: effectiveFeaturesResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Feature', value: f => f.key },
      { header: 'Name', value: f => f.label },
      { header: 'Enabled', value: f => (f.enabled ? 'yes' : 'no') },
    ])
  )
}
