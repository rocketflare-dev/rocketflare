/**
 * `rocketflare groups list` / `groups members <id>` (D29) — `GET /api/groups` and
 * `GET /api/groups/:id`, both `manage Group` (admin+), parsed with the shared schemas.
 *
 * Read-only on purpose: creating a group is a decision about who sees what, and the confirmation
 * the web UI gives before a delete narrows access has no honest one-line equivalent here.
 */
import { groupDetailSchema, groupListResponseSchema } from '@rocketflare/shared/groups'
import { type CommandContext, requireClient } from '../context'
import { formatDate, renderTable } from '../utils/output'

export async function runGroupsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/groups', {
    schema: groupListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Type', value: g => g.typeName },
      { header: 'Group', value: g => g.name },
      { header: 'People', value: g => String(g.memberCount) },
      { header: 'Id', value: g => g.id },
    ])
  )
}

export async function runGroupMembers(ctx: CommandContext, groupId: string): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', `/api/groups/${groupId}`, {
    schema: groupDetailSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.members, [
      { header: 'Email', value: m => m.email },
      { header: 'Name', value: m => m.name },
      { header: 'Added', value: m => formatDate(m.addedAt) },
    ])
  )
}
