/**
 * The kit's built-in agent tools (D7, D18) — what the runtime puts on `ctx.tools`, tenant-scoped
 * to the run. `search_knowledge` finds passages in the knowledge base, `get_document` reads a
 * document in full or by window. An app appends its own tools to `buildAgentTools`; an agent on
 * `runToolLoop` passes `[...ctx.tools, ...own, terminal]`.
 */
import type { Tool } from '../../ai/kit'
import { getDocumentTool } from './get-document'
import { type AgentToolContext, searchKnowledgeTool } from './search-knowledge'

export * from './get-document'
export * from './search-knowledge'

/** Every built-in tool a run gets on `ctx.tools`. */
export function buildAgentTools(ctx: AgentToolContext): Tool[] {
  return [searchKnowledgeTool(ctx) as Tool, getDocumentTool(ctx) as Tool]
}
