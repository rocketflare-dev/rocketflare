/**
 * `list_example_notes` (D31) — the plugin's contribution to every agent run's `ctx.tools`, and the
 * demonstration that a plugin can make its own data answerable without any agent importing it.
 *
 * Two rules it keeps, both the kit's:
 *
 * - **Bound to the RUN, not to the model.** The tenant comes from `ctx.scope`, which `executeRun`
 *   builds at execute time from the run's requester. Nothing the model says can widen it, and a
 *   `tenantId` argument on the schema would be exactly that mistake.
 * - **A dead end is still information.** An empty knowledge base answers with a `hint` telling the
 *   model what to do instead, because a tool that says only "nothing found" makes a model invent.
 */
import { z } from 'zod'
import type { AgentToolContext } from '../../../api/services/agents/tools'
import type { Tool } from '../../../api/services/ai/kit'
import { listExampleNotes } from '../api/notes'

export const LIST_EXAMPLE_NOTES_TOOL = 'list_example_notes'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** `z.coerce`, like every kit tool input: small models hand numbers back as strings. */
export const listExampleNotesInputSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many notes to list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}), newest first`),
})
export type ListExampleNotesInput = z.infer<typeof listExampleNotesInputSchema>

export function listExampleNotesTool(ctx: AgentToolContext): Tool<ListExampleNotesInput> {
  return {
    name: LIST_EXAMPLE_NOTES_TOOL,
    description:
      'List the example notes saved in this workspace, newest first, with their titles and text. ' +
      'Call it when the question is about what the team has written down here.',
    schema: listExampleNotesInputSchema,
    async handler(input) {
      const { items, total } = await listExampleNotes(ctx.db, ctx.scope.tenantId, {
        page: 1,
        pageSize: input.limit ?? DEFAULT_LIMIT,
      })
      if (total === 0) {
        return JSON.stringify({
          total: 0,
          notes: [],
          hint: 'No example notes have been written in this workspace. Say so rather than inventing one.',
        })
      }
      return JSON.stringify({
        total,
        notes: items.map(row => ({
          noteId: row.id,
          title: row.title,
          body: row.body,
          writtenAt: row.createdAt.toISOString(),
        })),
        ...(total > items.length && {
          hint: `Showing the ${items.length} newest of ${total}.`,
        }),
      })
    },
  }
}
