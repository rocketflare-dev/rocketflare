/**
 * `list_example_notes` — the plugin's contribution to every agent run's `ctx.tools`, and the
 * demonstration that a plugin can make its own data answerable without any agent importing it.
 *
 * Two rules it keeps, both core's:
 *
 * - **Bound to the RUN, not to the model.** The tenant comes from `ToolCtx`, which the runtime built
 *   at execute time from the run's requester — current membership, not a snapshot taken at enqueue.
 *   Nothing the model says can widen it, and a `tenantId` argument on the schema below would be
 *   exactly that mistake: the model choosing its own tenant.
 * - **A dead end is still information.** An empty knowledge base answers with a `hint` telling the
 *   model what to do instead, because a tool that says only "nothing found" makes a model invent.
 *
 * **On every surface, MCP included.** No `surfaces` means chat, agent runs and the MCP server; the
 * `mcp` block below is only what a client shows — a human title and the hints. Its scope and its
 * read-only hint follow from having no `sideEffects`, so it is listed under the default "all
 * read-only tools" exposure and needs only `mcp:read`. A plugin needs nothing else to reach a
 * client: no mount, no auth, no token check of its own — `/mcp` resolves the person, their
 * organisation and their permissions, and hands this tool the same `ToolCtx` chat would.
 *
 * `defineTool` is a thin declaration helper; what it buys is that a plugin names `Tool` from the
 * plugin surface rather than from `services/ai/agent-loop`, which lives inside the deletable
 * `feature-agents` surface.
 */
import { EXAMPLE_FEATURE_FLAG } from '@rocketflare/shared/plugins/example-feature/index'
import { z } from 'zod'
import type { Tool, ToolCtx } from '@/plugins/api'
import { defineTool } from '@/plugins/api'
import { listExampleNotes } from '../api/notes'

export const LIST_EXAMPLE_NOTES_TOOL = 'list_example_notes'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** `z.coerce`, like every core tool input: small models hand numbers back as strings. */
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

/**
 * What `tools` contributes: the tool while the organisation has the flag, nothing otherwise.
 * The flag gates the mount and the nav; without this it would not gate the prompt, and every chat
 * turn and agent run of a deployment that never turned the feature on would carry the tool.
 */
export async function exampleAgentTools(ctx: ToolCtx): Promise<Tool[]> {
  const features = await ctx.features()
  return features.includes(EXAMPLE_FEATURE_FLAG) ? [listExampleNotesTool(ctx) as Tool] : []
}

export function listExampleNotesTool(ctx: ToolCtx): Tool<ListExampleNotesInput> {
  return defineTool({
    name: LIST_EXAMPLE_NOTES_TOOL,
    description:
      'List the example notes saved in this workspace, newest first, with their titles and text. ' +
      'Call it when the question is about what the team has written down here.',
    schema: listExampleNotesInputSchema,
    mcp: {
      title: 'List example notes',
      // Reads only this workspace's own rows: nothing outside it, so not an open world.
      annotations: { openWorldHint: false },
    },
    async handler(input) {
      const { items, total } = await listExampleNotes(ctx.db, ctx.tenantId, {
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
  })
}
