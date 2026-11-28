/**
 * `rocketflare example-sales leads` — the example sales domain's CLI half: one read-list command,
 * wired by one line in `apps/cli/src/app.ts`. It imports the CLI through the same declared entry a
 * plugin's commands do (`../plugins/api`) and parses the domain's own shared contract.
 */
import {
  EXAMPLE_SALES_ID,
  exampleSalesShared,
  leadListResponseSchema,
} from '@rocketflare/shared/example-sales/index'
import type { CliPlugin, CommandContext } from '../plugins/api'
import { formatPagination, renderTable, requireClient } from '../plugins/api'

export interface LeadListOptions {
  page?: string
  pageSize?: string
}

export async function runLeadsList(ctx: CommandContext, options: LeadListOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/example-sales/leads', {
    schema: leadListResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Lead', value: l => l.name },
      { header: 'Company', value: l => l.company },
      { header: 'Status', value: l => l.status },
      { header: 'Score', value: l => (l.score === null ? '' : String(l.score)) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export const exampleSalesCli: CliPlugin<typeof exampleSalesShared> = {
  shared: exampleSalesShared,
  register(program, action) {
    const root = program
      .command(EXAMPLE_SALES_ID)
      .description('the example sales domain (an app domain — safe to delete)')
    root
      .command('leads')
      .description('list leads in the active tenant')
      .option('--page <n>', 'page number')
      .option('--page-size <n>', 'items per page (max 200)')
      .action(action((ctx, cmd) => runLeadsList(ctx, cmd.opts())))
  },
}
