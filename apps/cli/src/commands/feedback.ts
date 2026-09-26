/**
 * `rocketflare feedback list` — thumbs on AI answers (`GET /api/feedback`, admin+) (D33).
 *
 * The promotion queue: `--rating down` is where eval cases come from. Each row names the rated
 * target (`message` / `agent_run`) and its id, which is exactly what `rocketflare evals promote`
 * and `rocketflare traces show` take.
 */
import { feedbackListResponseSchema } from '@rocketflare/shared/ai/evals'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface FeedbackListOptions {
  rating?: 'up' | 'down'
  target?: 'message' | 'agent_run'
  page?: number
  pageSize?: number
}

export async function runFeedbackList(
  ctx: CommandContext,
  options: FeedbackListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/feedback', {
    schema: feedbackListResponseSchema,
    query: {
      rating: options.rating,
      target: options.target,
      page: options.page,
      pageSize: options.pageSize,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: f => formatDate(f.updatedAt) },
      { header: 'Rating', value: f => (f.rating === 1 ? chalk.green('up') : chalk.red('down')) },
      { header: 'Target', value: f => f.target },
      { header: 'Id', value: f => f.targetId },
      { header: 'Comment', value: f => (f.comment ? f.comment.slice(0, 60) : '') },
      { header: 'User', value: f => f.userId?.slice(0, 8) ?? '' },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
  if (!ctx.json && data.items.length > 0) {
    ctx.log.hint(`Promote one: ${ctx.binName} evals promote <id> --dataset <name>`)
  }
}
