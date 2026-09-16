/**
 * `rocketflare example-feature …` — the reference plugin's CLI half (D31).
 *
 * Two commands, one per pattern an app usually needs:
 *
 *   rocketflare example-feature ping          POST /api/example-feature/ping  — enqueue the smoke job
 *   rocketflare example-feature notes list    GET  /api/example-feature/notes — the read-list shape
 *
 * **The CLI never owns a second copy of the contract.** It builds no job envelope of its own — the
 * ping command calls the route that enqueues, so producer validation, the envelope stamp and the
 * `JOBS_QUEUE` binding all stay on the server — and it parses every response with the same
 * `@rocketflare/shared` schema the server validated with. It throws `CliError` and never prints an
 * error or calls `process.exit`: it registers with the host's own `action()` wrapper, so it
 * inherits one context, one error printer and one exit-code mapping (0 · 1 · 2 · 3).
 *
 * The top-level command name is the plugin's id, which is what keeps two installed plugins from
 * claiming the same word.
 */
import { paginatedResponse } from '@rocketflare/shared/pagination'
import {
  EXAMPLE_FEATURE_ID,
  exampleFeatureShared,
  exampleNoteSchema,
  examplePingResponseSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import type { CommandContext } from '../../context'
import { requireClient } from '../../context'
import { formatDate, formatPagination, renderTable } from '../../utils/output'
import type { CliPlugin } from '../types'

const notesListSchema = paginatedResponse(exampleNoteSchema)

/** Commander hands option values back as strings; the route's query schema coerces them. */
export interface ListOptions {
  page?: string
  pageSize?: string
}

export async function runExamplePing(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', '/api/example-feature/ping', {
    schema: examplePingResponseSchema,
  })
  ctx.out.data(raw, () => `Queued ${data.type} (${data.jobId}) at ${data.enqueuedAt}`)
}

export async function runExampleNotesList(
  ctx: CommandContext,
  options: ListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/example-feature/notes', {
    schema: notesListSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Title', value: n => n.title },
      { header: 'Note', value: n => n.body.slice(0, 60) },
      { header: 'Created', value: n => formatDate(n.createdAt) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export const exampleFeatureCli: CliPlugin<typeof exampleFeatureShared> = {
  shared: exampleFeatureShared,
  register(program, action) {
    const root = program
      .command(EXAMPLE_FEATURE_ID)
      .description('the example feature (a plugin — safe to delete)')
    root
      .command('ping')
      .description('enqueue the example-feature.ping smoke job')
      .action(action(ctx => runExamplePing(ctx)))
    const notes = root.command('notes').description('example notes in the active tenant')
    notes
      .command('list', { isDefault: true })
      .description('list notes')
      .option('--page <n>', 'page number')
      .option('--page-size <n>', 'items per page (max 200)')
      .action(action((ctx, cmd) => runExampleNotesList(ctx, cmd.opts())))
  },
}
