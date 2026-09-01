/** `rocketflare members list [--page] [--page-size]` — `GET /api/members` → `paginatedResponse(memberSchema)` (D26). */
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { memberSchema } from '@rocketflare/shared/tenants'
import { type CommandContext, requireClient } from '../context'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface ListOptions {
  page?: number
  pageSize?: number
}

export const membersListSchema = paginatedResponse(memberSchema)

export async function runMembersList(
  ctx: CommandContext,
  options: ListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/members', {
    schema: membersListSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Email', value: m => m.email },
      { header: 'Name', value: m => m.name },
      { header: 'Role', value: m => m.role },
      { header: 'Joined', value: m => formatDate(m.joinedAt) },
      { header: 'Last login', value: m => formatDate(m.lastLoginAt) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}
