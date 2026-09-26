/**
 * Promotion from real traffic (D33): turn one assistant message or one agent run into a DRAFT
 * `EvalCase` — `GET /api/evals/export`, read by `rocketflare evals promote`. The draft is honest
 * about what it is:
 *
 * - `input` is what the person asked (the user turn before the answer, or the run's input) and
 *   `messages` the conversation before it, oldest first, capped.
 * - `context` is what the knowledge tools actually RETRIEVED during that answer (the passages
 *   `search_knowledge` returned, grouped by document), so a faithfulness judge grades the case
 *   against the same material the model saw — not against whatever the knowledge base holds today.
 * - `expected.output` is the OBSERVED answer, a starting point for a person to correct. It is never
 *   a gold answer until somebody signs it off, which is the `rf-evals` skill's hard stop.
 * - `expected.tools` is the tools that were called, in order — the trajectory the case pins.
 *
 * Every read carries the tenant predicate; the route is admin+ (`read Feedback`) because the
 * result is another member's conversation.
 */
import type { AgentToolEndEventData, AgentToolStartEventData } from '@rocketflare/shared/ai/agents'
import type { ToolCallRecord } from '@rocketflare/shared/ai/chat'
import type {
  EvalCase,
  EvalContextDoc,
  EvalExportQuery,
  EvalMessage,
} from '@rocketflare/shared/ai/evals'
import { evalCaseSchema } from '@rocketflare/shared/ai/evals'
import { and, asc, desc, eq, lt, or } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { agentRunEvents, agentRuns, aiFeedback, messages } from '../../db/schema'
import { NotFoundError } from '../utils/core/errors'
import { SEARCH_KNOWLEDGE_TOOL } from './agents/tools/search-knowledge'

/** Earlier turns a promoted chat case keeps — enough to reproduce the turn, not the whole thread. */
export const EVAL_EXPORT_HISTORY_MAX = 12

/** Longest context document kept per case; a case file is read by people in a pull request. */
const CONTEXT_DOC_MAX_CHARS = 8000

interface PassageLike {
  text?: unknown
}
interface SearchDocLike {
  title?: unknown
  passages?: PassageLike[]
}

/**
 * The documents a `search_knowledge` answer carried, one entry per document with its passages
 * joined. Tolerant by design: the result JSON is the tool's internal shape (retuned whenever its
 * budget changes), and a draft with less context beats an export that fails.
 */
export function contextFromSearchResult(result: unknown): EvalContextDoc[] {
  let parsed: unknown = result
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result)
    } catch {
      return []
    }
  }
  const documents = (parsed as { documents?: SearchDocLike[] } | null)?.documents
  if (!Array.isArray(documents)) return []
  const docs: EvalContextDoc[] = []
  for (const doc of documents) {
    const title = typeof doc.title === 'string' && doc.title ? doc.title : 'Untitled'
    const text = (doc.passages ?? [])
      .map(p => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, CONTEXT_DOC_MAX_CHARS)
    if (text) docs.push({ title: title.slice(0, 200), text })
  }
  return docs
}

/** Merge per-call context into one list, one entry per title (later passages appended). */
function mergeContext(parts: EvalContextDoc[][]): EvalContextDoc[] {
  const byTitle = new Map<string, string>()
  for (const doc of parts.flat()) {
    const existing = byTitle.get(doc.title)
    if (existing === undefined) byTitle.set(doc.title, doc.text)
    else if (!existing.includes(doc.text)) {
      byTitle.set(doc.title, `${existing}\n\n${doc.text}`.slice(0, CONTEXT_DOC_MAX_CHARS))
    }
  }
  return [...byTitle].map(([title, text]) => ({ title, text }))
}

async function feedbackFor(
  db: Database,
  tenantId: string,
  target: 'message' | 'agent_run',
  targetId: string
): Promise<{ rating: 1 | -1; comment: string | null } | null> {
  // The most recent vote wins when several people rated one run: it is the one that prompted this.
  const [row] = await db
    .select({ rating: aiFeedback.rating, comment: aiFeedback.comment })
    .from(aiFeedback)
    .where(
      and(
        eq(aiFeedback.tenantId, tenantId),
        eq(aiFeedback.target, target),
        eq(aiFeedback.targetId, targetId)
      )
    )
    .orderBy(desc(aiFeedback.updatedAt))
    .limit(1)
  return row ?? null
}

async function caseFromMessage(
  db: Database,
  tenantId: string,
  messageId: string
): Promise<EvalCase> {
  const answer = await db.query.messages.findFirst({
    where: and(
      eq(messages.tenantId, tenantId),
      eq(messages.id, messageId),
      eq(messages.role, 'assistant')
    ),
  })
  if (!answer) throw new NotFoundError('Message not found', 'message_not_found')
  const earlier = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, answer.conversationId),
        or(
          lt(messages.createdAt, answer.createdAt),
          and(eq(messages.createdAt, answer.createdAt), lt(messages.id, answer.id))
        )
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(EVAL_EXPORT_HISTORY_MAX + 1)
  const history = earlier
    .reverse()
    .filter(m => m.role === 'user' || m.role === 'assistant') as EvalMessage[]
  const question = history.at(-1)?.role === 'user' ? history.pop() : undefined
  if (!question) {
    throw new NotFoundError('That answer has no question before it', 'message_not_found')
  }
  const calls: ToolCallRecord[] = answer.toolCalls ?? []
  return evalCaseSchema.parse({
    id: `message-${answer.id.slice(0, 8)}`,
    input: question.content,
    messages: history.slice(-EVAL_EXPORT_HISTORY_MAX),
    context: mergeContext(
      calls
        .filter(c => c.name === SEARCH_KNOWLEDGE_TOOL)
        .map(c => contextFromSearchResult(c.result))
    ),
    expected: {
      output: answer.content,
      ...(calls.length ? { tools: calls.map(c => c.name) } : {}),
    },
    tags: ['promoted', 'chat'],
    source: {
      kind: 'message',
      id: answer.id,
      promotedAt: new Date(),
      feedback: await feedbackFor(db, tenantId, 'message', answer.id),
    },
  })
}

async function caseFromRun(db: Database, tenantId: string, runId: string): Promise<EvalCase> {
  const run = await db.query.agentRuns.findFirst({
    where: and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, runId)),
  })
  if (!run) throw new NotFoundError('Agent run not found', 'agent_run_not_found')
  const events = await db
    .select({ type: agentRunEvents.type, data: agentRunEvents.data })
    .from(agentRunEvents)
    .where(and(eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.runId, runId)))
    .orderBy(asc(agentRunEvents.seq))
  const tools = events
    .filter(e => e.type === 'tool.start')
    .map(e => (e.data as AgentToolStartEventData).name)
    .filter((name): name is string => typeof name === 'string')
  const context = mergeContext(
    events
      .filter(e => e.type === 'tool.end')
      .map(e => e.data as AgentToolEndEventData)
      .filter(d => d.name === SEARCH_KNOWLEDGE_TOOL)
      .map(d => contextFromSearchResult(d.result))
  )
  const input =
    run.input && typeof run.input === 'object' && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>)
      : { value: run.input }
  return evalCaseSchema.parse({
    id: `run-${run.id.slice(0, 8)}`,
    input,
    context,
    expected: {
      ...(run.output !== null && run.output !== undefined ? { output: run.output } : {}),
      ...(tools.length ? { tools } : {}),
    },
    tags: ['promoted', 'agent', run.agentKey],
    source: {
      kind: 'agent_run',
      id: run.id,
      promotedAt: new Date(),
      feedback: await feedbackFor(db, tenantId, 'agent_run', run.id),
    },
    agentKey: run.agentKey,
  })
}

export function exportEvalCase(
  db: Database,
  tenantId: string,
  query: EvalExportQuery
): Promise<EvalCase> {
  if (query.messageId) return caseFromMessage(db, tenantId, query.messageId)
  return caseFromRun(db, tenantId, query.runId as string)
}
