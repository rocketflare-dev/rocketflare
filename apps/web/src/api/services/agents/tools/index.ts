/**
 * The built-in agent tools — what the runtime puts on `ctx.tools`, tenant-scoped to
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
import type { AnyServerPlugin } from '../../../../plugins/server'
import { serverPlugins } from '../../../../plugins/server'
import { loggerFor } from '../../../utils/core/logger'
import type { AccessScope } from '../../access-sql'
import type { Tool } from '../../ai/agent-loop'
import { getDocumentTool } from './get-document'
import { listDocumentsTool } from './list-documents'
import { type AgentToolContext, searchKnowledgeTool } from './search-knowledge'

export * from './event-summary'
export * from './get-document'
export * from './list-documents'
export * from './search-knowledge'

/**
 * Every built-in tool a run gets on `ctx.tools`, in the order an agent normally needs them —
 * followed by whatever the installed plugins add, which is how a plugin makes its own data
 * answerable without every agent importing it. A plugin tool is built from the same `ctx`, so it
 * is bound to the run's tenant and access scope like the three above.
 *
 * A plugin's `agentTools` may be ASYNC, and that is what lets it answer per tenant: it reads its
 * own settings row for `ctx.scope.tenantId` and returns `[]` when the tenant has not turned it on,
 * so the model never sees a tool that could only fail. **A builder that throws is logged and
 * skipped** — one broken plugin must not take chat or every agent run down with it.
 */
export async function buildAgentTools(ctx: AgentToolContext): Promise<Tool[]> {
  const log = loggerFor(ctx.cfg, {})
  const platformSources = await pluginKnowledgeSources(serverPlugins, ctx.scope, (pluginId, err) =>
    log.warn({ err, pluginId }, 'plugin knowledgeSources failed; its sources are left out')
  )
  const contributed = await Promise.allSettled(
    serverPlugins.map(async p => (await p.agentTools?.(ctx)) ?? [])
  )
  const pluginTools = contributed.flatMap((result, i) => {
    if (result.status === 'fulfilled') return result.value
    loggerFor(ctx.cfg, { pluginId: serverPlugins[i]?.shared.id }).warn(
      { err: result.reason },
      'plugin agentTools failed; its tools are left out of this run'
    )
    return []
  })
  return [
    searchKnowledgeTool(ctx, { platformSources }) as Tool,
    getDocumentTool(ctx) as Tool,
    listDocumentsTool(ctx) as Tool,
    ...pluginTools,
  ]
}

/** `<plugin id>:<kind>` — what a platform source must look like (and never the core `kit:`). */
const PLATFORM_SOURCE = /^([a-z][a-z0-9-]*):\S/

/**
 * The PLATFORM sources the `search_knowledge` tool covers for this reader: the union, deduplicated
 * and in plugin order, of every plugin's `knowledgeSources(scope)`. A builder that throws is
 * reported through `onError` and contributes nothing; a source that is not `<id>:<kind>` (or is
 * `kit:`) is reported and dropped — a plugin can widen the search only onto namespaced sources.
 */
export async function pluginKnowledgeSources(
  plugins: readonly Pick<AnyServerPlugin, 'shared' | 'knowledgeSources'>[],
  scope: AccessScope,
  onError: (pluginId: string, err: unknown) => void
): Promise<string[]> {
  const answers = await Promise.allSettled(
    plugins.map(async p => (await p.knowledgeSources?.(scope)) ?? [])
  )
  const out = new Set<string>()
  answers.forEach((answer, i) => {
    const pluginId = plugins[i]?.shared.id ?? 'unknown'
    if (answer.status === 'rejected') {
      onError(pluginId, answer.reason)
      return
    }
    for (const source of answer.value) {
      const ns = PLATFORM_SOURCE.exec(source)?.[1]
      if (!ns || ns === 'kit') onError(pluginId, new Error(`not a namespaced source: "${source}"`))
      else out.add(source)
    }
  })
  return [...out]
}
