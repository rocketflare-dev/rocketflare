/**
 * `research-topic` — the kit's second example agent (D7, D17, D18), and the one that shows the
 * agentic shape: `runToolLoop` over the built-in knowledge tools (`ctx.tools` — `search_knowledge`,
 * `get_document`) until the model calls the terminal `submit_answer`. Where `summarize-text` is one
 * forced tool call, this one lets the model decide how many searches it needs, capped by
 * `AGENT_MAX_TURNS`. Copy it to start an agent that has to look things up.
 *
 * Two decisions worth knowing before you edit it:
 *
 * - **A loop that ends without the terminal tool is salvaged, not failed.** The zero-key floor is
 *   Workers AI, which has no `tool_choice` (a model that answers in prose is a live failure mode,
 *   not an edge case), so `no_tool_call` / `max_turns` falls back to ONE `callStructuredTool` over
 *   the transcript — the same forced-tool + prose-JSON recovery the rest of the kit uses. Only if
 *   that also fails does the run fail, carrying the model's own words in the error details.
 * - **Citations are filtered to what search actually returned.** Every `documentId` the tools
 *   reported is recorded during the loop; a citation naming anything else is dropped rather than
 *   persisted, so a hallucinated id can never reach the UI. The title comes from the search hit,
 *   not from the model.
 */
import {
  RESEARCH_TOPIC_MAX_CITATIONS,
  type ResearchTopicInput,
  type ResearchTopicOutput,
  researchTopicInputSchema,
  researchTopicOutputSchema,
} from '@rocketflare/shared/ai/agents'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import { z } from 'zod'
import { callStructuredTool, runToolLoop, type Tool } from '../../ai/kit'
import type { ChatMessage } from '../../ai/types'
import { recordUsage } from '../../ai/usage'
import type { AgentContext, AgentDefinition } from '../registry'
import { summariseToolResult } from '../tools'

export const SUBMIT_ANSWER_TOOL = 'submit_answer'

/**
 * Per-turn output cap. `AGENT_MAX_OUTPUT_TOKENS` (16 384) is a per-agent ceiling, not a sensible
 * per-turn ask: a research answer is a page of prose, and a 24B model on the Workers AI floor is
 * being asked to reserve most of its window for output it will never produce.
 */
export const ANSWER_MAX_TOKENS = 4_096
/**
 * Turn cap for THIS agent, under `AGENT_MAX_TURNS`. Every turn appends its tool results to the
 * transcript, so the loop's context grows with each search; a research question that needs more
 * than a handful of searches needs a narrower question, not a longer loop.
 */
export const RESEARCH_MAX_TURNS = 8

const submitAnswerSchema = z.object({
  answer: z
    .string()
    .min(1)
    .describe('The answer in Markdown, attributing each claim to the document it came from.'),
  citations: z
    .array(
      z.object({
        documentId: z.string().describe('The documentId exactly as search_knowledge reported it'),
        title: z.string().describe('That document’s title'),
      })
    )
    .max(RESEARCH_TOPIC_MAX_CITATIONS)
    .describe('One entry per document actually used; empty when the knowledge base had nothing.'),
})
type SubmitAnswer = z.infer<typeof submitAnswerSchema>

/** The terminal tool: no handler, so `runToolLoop` never executes it — its input is the answer. */
const submitAnswerTool: Tool<SubmitAnswer> = {
  name: SUBMIT_ANSWER_TOOL,
  description:
    'Submit the finished answer and the documents it cites. Call exactly once, when you can answer the question or have established that the knowledge base does not hold the answer.',
  schema: submitAnswerSchema,
}

/**
 * Document ids (→ titles) the tools actually returned this run. Written from every
 * `search_knowledge` / `get_document` result, read when the citations are filtered.
 */
function collectDocuments(resultText: string, into: Map<string, string>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return // a prose answer from a tool (e.g. "not available") carries no ids
  }
  const named = z.object({ documentId: z.string().uuid(), title: z.string() })
  const shape = z
    .object({
      // `get_document`: the document it read.
      documentId: z.string().uuid().optional(),
      title: z.string().optional(),
      // `search_knowledge`: the documents its passages came from.
      documents: z.array(named).optional(),
      // `list_documents`, and the "nothing matched" / "unknown id" answers.
      knowledgeBase: z.array(named).optional(),
    })
    .passthrough()
    .safeParse(parsed)
  if (!shape.success) return
  if (shape.data.documentId && shape.data.title !== undefined) {
    into.set(shape.data.documentId, shape.data.title)
  }
  for (const doc of [...(shape.data.documents ?? []), ...(shape.data.knowledgeBase ?? [])]) {
    into.set(doc.documentId, doc.title)
  }
}

/** Keep only citations naming a document the tools returned; take the title from the tool, not the model. */
function verifyCitations(
  citations: SubmitAnswer['citations'],
  seen: Map<string, string>
): ResearchTopicOutput['citations'] {
  const kept = new Map<string, string>()
  for (const citation of citations) {
    const title = seen.get(citation.documentId)
    if (title === undefined) continue
    kept.set(citation.documentId, title || citation.title)
  }
  return [...kept].map(([documentId, title]) => ({ documentId, title }))
}

export const researchTopicAgent: AgentDefinition<ResearchTopicInput, ResearchTopicOutput> = {
  meta: {
    key: 'research-topic',
    title: 'Research a topic',
    description:
      'Researches a question against this workspace’s knowledge base — searching and reading documents as needed — and answers with citations.',
    inputSchema: researchTopicInputSchema,
    outputSchema: researchTopicOutputSchema,
    promptKey: 'research-topic',
    exclusive: true,
  },

  async run(ctx: AgentContext<ResearchTopicInput>) {
    const topic = ctx.input.topic.trim()
    const system = await ctx.prompt()
    const messages: ChatMessage[] = [{ role: 'user', content: `Research this: ${topic}` }]
    /** documentId → title, from the tools' own answers. */
    const seen = new Map<string, string>()
    /**
     * Written the moment tokens are spent, not at the end: a failed salvage or a cancellation
     * between turns must still leave the loop's tokens in the ledger. (`runToolLoop` has no
     * per-turn usage tap, so a cancel mid-loop still loses that run's tokens — a kit gap.)
     */
    const ledger = (usage: TokenUsage) =>
      recordUsage(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        feature: 'agent:research-topic',
        provider: ctx.chat.client.provider,
        model: ctx.chat.model,
        usage,
      }).catch(err => ctx.logger.warn({ err }, 'research-topic: usage write failed'))

    await ctx.step('research', 'Searching the knowledge base', 'running')
    const loop = await runToolLoop(ctx.chat.client, {
      model: ctx.chat.model,
      maxTokens: Math.min(ctx.chat.maxOutputTokens, ANSWER_MAX_TOKENS),
      system,
      messages,
      tools: [...ctx.tools, submitAnswerTool as Tool],
      maxTurns: Math.min(ctx.cfg.AGENT_MAX_TURNS, RESEARCH_MAX_TURNS),
      // The loop takes no AbortSignal, so these two callbacks ARE the cancellation poll: once per
      // model turn, and once per tool result — a run doing slow tool work still stops promptly.
      onStep: async step => {
        await ctx.checkCancelled()
        if (!step.terminal && step.toolNames.length > 0) {
          await ctx.step(
            'research',
            'Searching the knowledge base',
            'running',
            `turn ${step.turn}: ${step.toolNames.join(', ')}`
          )
        }
      },
      onEvent: async event => {
        // The terminal tool is not a tool call a person cares about: its "call" IS the answer,
        // which the run's output already shows. Emitting it duplicated the answer twice over.
        if (event.kind !== 'text' && event.name === SUBMIT_ANSWER_TOOL) return
        if (event.kind === 'text') {
          await ctx.emit({ type: 'text', data: { text: event.text } })
        } else if (event.kind === 'tool_call') {
          await ctx.emit({ type: 'tool.start', data: { name: event.name, input: event.input } })
        } else {
          await ctx.checkCancelled()
          collectDocuments(event.resultText, seen)
          await ctx.emit({
            type: 'tool.end',
            data: {
              name: event.name,
              isError: event.isError,
              // Structured and previewed, not a truncated JSON string: this row IS the audit trail
              // for "where did the answer come from?".
              result: summariseToolResult(event.name, event.resultText),
            },
          })
        }
      },
    })
    await ledger(loop.usage)
    await ctx.step(
      'research',
      'Searching the knowledge base',
      'done',
      `${loop.turns} turn${loop.turns === 1 ? '' : 's'}, ${seen.size} document${seen.size === 1 ? '' : 's'} consulted`
    )
    await ctx.checkCancelled()

    // Salvage: the model stopped without the terminal call (prose, or the turn cap). Ask once more
    // with the tool forced over the transcript we already have.
    let submitted = loop.terminalInput as SubmitAnswer | null
    const salvaged = submitted === null
    if (!submitted) {
      await ctx.step('answer', 'Writing the answer', 'running', `recovering (${loop.stopReason})`)
      submitted = await callStructuredTool(ctx.chat.client, {
        model: ctx.chat.model,
        maxTokens: Math.min(ctx.chat.maxOutputTokens, ANSWER_MAX_TOKENS),
        system,
        messages: loop.messages,
        tool: {
          name: SUBMIT_ANSWER_TOOL,
          description: submitAnswerTool.description,
          schema: submitAnswerSchema,
        },
        // The loop just sent this transcript with rolling breakpoints, so on a caching provider
        // (Anthropic) the recovery reads the prefix instead of paying for it twice.
        cache: true,
        // Fires before `callStructuredTool` throws, so a failed recovery is still ledgered.
        onUsage: extra => void ledger(extra),
      })
    }

    const citations = verifyCitations(submitted.citations, seen)
    // No `text` event for the answer: it is the run's output, rendered once by the output panel.
    await ctx.step(
      'answer',
      'Writing the answer',
      'done',
      `${citations.length} citation${citations.length === 1 ? '' : 's'}`
    )
    return { answer: submitted.answer, citations, turns: loop.turns + (salvaged ? 1 : 0) }
  },
}
