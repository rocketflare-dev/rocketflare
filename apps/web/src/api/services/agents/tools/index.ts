/**
 * The kit's built-in agent tools (D7, D18) — what the runtime puts on `ctx.tools`, tenant-scoped to
 * the run. Three, and they answer the three questions an agent has about the knowledge base:
 * `list_documents` — what is in it; `search_knowledge` — which passages match these words (whole
 * passages, grouped by document); `get_document` — the full text of one, by window. Each answers
 * in JSON, and each dead end (no match, unknown id, no embeddings provider) answers with an
 * `error`/`hint` the model can act on plus, where useful, the documents that DO exist — a tool
 * that says only "nothing found" makes a model invent. An app appends its own tools to
 * `buildAgentTools`; an agent on `runToolLoop` passes `[...ctx.tools, ...own, terminal]`.
 *
 * Every numeric input is `z.coerce.number()`: small models — the Workers AI floor among them — hand
 * back tool arguments with the numbers as strings (`"offset": "29525"`), and rejecting that wastes
 * a turn on a validation error the model often cannot diagnose. Coerce what is unambiguous; keep
 * the bounds.
 */
import type { Tool } from '../../ai/kit'
import { getDocumentTool } from './get-document'
import { listDocumentsTool } from './list-documents'
import { type AgentToolContext, searchKnowledgeTool } from './search-knowledge'

export * from './event-summary'
export * from './get-document'
export * from './list-documents'
export * from './search-knowledge'

/** Every built-in tool a run gets on `ctx.tools`, in the order an agent normally needs them. */
export function buildAgentTools(ctx: AgentToolContext): Tool[] {
  return [
    searchKnowledgeTool(ctx) as Tool,
    getDocumentTool(ctx) as Tool,
    listDocumentsTool(ctx) as Tool,
  ]
}
