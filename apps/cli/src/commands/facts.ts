/**
 * `rocketflare facts review` and `facts confirm|reject|prefer <factId>` — the knowledge-facts
 * review items (`GET /api/knowledge/review`) and settling one fact
 * (`POST /api/knowledge/facts/:id/review`), parsed with the shared schemas.
 *
 * `review` lists the items addressed to the key's user — everyone's for an admin unless `--mine`.
 * A possible match (two names that may be one entity) is listed with its candidates but settled in
 * the web app, where both entities' facts sit side by side: merging moves facts, and a one-line
 * command is not the place to decide that blind. The routes 404 `feature_disabled` while the
 * tenant does not have knowledge facts.
 */
import {
  type FactReviewAction,
  factReviewResponseSchema,
  KNOWLEDGE_REVIEW_KINDS,
  type KnowledgeReviewItem,
  knowledgeReviewListSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import chalk from 'chalk'
import { CliApiError } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { formatPagination, neutralise, renderTable } from '../utils/output'

export interface FactsReviewOptions {
  mine?: boolean
  kind?: string
  page?: number
  pageSize?: number
}

function featureHint(error: unknown): never {
  if (error instanceof CliApiError && error.code === 'feature_disabled') {
    throw new CliError('Knowledge facts are not turned on for this organisation', {
      cause: error,
    })
  }
  throw error
}

const itemValue = (item: KnowledgeReviewItem): string =>
  item.kind === 'fact' ? item.fact.valueText : item.candidates.map(c => c.label).join(' / ')

export async function runFactsReview(
  ctx: CommandContext,
  options: FactsReviewOptions = {}
): Promise<void> {
  if (options.kind && !(KNOWLEDGE_REVIEW_KINDS as readonly string[]).includes(options.kind)) {
    throw new CliError(`--kind must be one of ${KNOWLEDGE_REVIEW_KINDS.join(', ')}`)
  }
  const { data, raw } = await requireClient(ctx)
    .request('GET', '/api/knowledge/review', {
      schema: knowledgeReviewListSchema,
      query: {
        mine: options.mine ? 'true' : undefined,
        kind: options.kind,
        page: options.page,
        pageSize: options.pageSize,
      },
    })
    .catch(featureHint)
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      {
        header: 'Item',
        value: i =>
          i.kind === 'possibleMatch'
            ? 'same as?'
            : i.fact.state === 'conflicting'
              ? 'conflict'
              : 'unsure',
        style: (text, i) =>
          i.kind === 'fact' && i.fact.state === 'conflicting'
            ? chalk.red(text)
            : chalk.yellow(text),
      },
      { header: 'About', value: i => i.entity.name },
      { header: 'Key', value: i => (i.kind === 'fact' ? i.fact.key : '') },
      { header: 'Value', value: i => itemValue(i).slice(0, 50) },
      {
        header: 'Other sides',
        value: i =>
          i.kind === 'fact'
            ? i.conflicts
                .map(c => c.valueText)
                .join(' / ')
                .slice(0, 40)
            : '',
      },
      { header: 'Id', value: i => (i.kind === 'fact' ? i.fact.id : i.entity.id) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
  if (!ctx.json && data.items.length > 0) {
    ctx.log.hint(
      `Settle a fact: ${ctx.binName} facts confirm|reject|prefer <id>. "same as?" items are settled in the web app.`
    )
  }
}

export async function runFactsSettle(
  ctx: CommandContext,
  action: FactReviewAction,
  factId: string
): Promise<void> {
  if (!factId) throw new CliError('Give the id of the fact (from `facts review`)')
  const { data, raw } = await requireClient(ctx)
    .request('POST', `/api/knowledge/facts/${encodeURIComponent(factId)}/review`, {
      schema: factReviewResponseSchema,
      body: { action },
    })
    .catch(featureHint)
  const others = data.affected.length
  ctx.out.data(
    raw,
    () =>
      `${neutralise(data.fact.key)} is now ${data.fact.state}` +
      (others > 0 ? ` (${others} other fact${others === 1 ? '' : 's'} changed with it)` : '') +
      '.'
  )
}
