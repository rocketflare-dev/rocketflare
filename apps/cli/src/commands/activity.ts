/** `gmgo activity list [--page] [--page-size] [--type]` — `GET /api/activity` (admin+) (D26). */
import { activityEventSchema } from '@gmgo/shared/activity'
import { paginatedResponse } from '@gmgo/shared/pagination'
import { type CommandContext, requireClient } from '../context'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface ActivityListOptions {
  page?: number
  pageSize?: number
  type?: string
}

export const activityListSchema = paginatedResponse(activityEventSchema)

export async function runActivityList(
  ctx: CommandContext,
  options: ActivityListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/activity', {
    schema: activityListSchema,
    query: { page: options.page, pageSize: options.pageSize, type: options.type },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: e => formatDate(e.createdAt) },
      { header: 'Type', value: e => e.type },
      { header: 'Actor', value: e => e.actor?.email ?? e.userId ?? 'system' },
      {
        header: 'Subject',
        value: e => (e.subjectType ? `${e.subjectType}:${e.subjectId ?? '-'}` : '-'),
      },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}
