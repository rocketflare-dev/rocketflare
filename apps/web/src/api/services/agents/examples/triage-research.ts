/**
 * `triage-research` — the decisions example, and the recommended shape for a job an
 * agent does over and over: **a question decides what a thing IS; code decides what follows; an
 * agent runs only where something must be found, or where no question could settle it.**
 *
 *   search      one `search_knowledge` call (the built-in tool, not a model turn)
 *   screen      `ctx.decide.sift` — ONE request, the same yes/no of every passage: does it help
 *               answer the question? Code keeps the ones at or above `RELEVANCE_THRESHOLD`.
 *   triage      `ctx.decide` — taken together, do the kept passages answer it?
 *   route       code: answerable → answer from the kept passages only (one forced call);
 *               confidently not → say the knowledge base does not cover it (no model call);
 *               unsure → ESCALATE to the full `research-topic` loop, which searches, reads and
 *               reasons for as many turns as it needs. The expensive agent is kept for the odd case.
 *
 * Where `research-topic` spends a model turn deciding what each search hit means, this spends one
 * decision on all of them — and records it. Every answer and its confidence is in
 * `agent_run_decisions`, so "why was this passage ignored?" has a row, and changing the threshold
 * below is a code change that can be checked against recorded answers rather than a prompt edit.
 *
 * It is NON-exclusive: the shape is meant for volume, so a batch of a hundred questions is a
 * hundred concurrent runs, each metered and held to the run budget.
 *
 * Retry safety: the search runs inside `ctx.once`, so a re-entered `run()` screens the SAME
 * passages its recorded decision was about — a decision replayed over a different item list would
 * be quietly wrong. The decisions themselves replay by key; the answer call is behind `ctx.once`.
 */
import {
  RESEARCH_TOPIC_MAX_CITATIONS,
  type TriageResearchInput,
  type TriageResearchOutput,
  triageResearchInputSchema,
  triageResearchOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { KNOWLEDGE_TOOLS } from '@rocketflare/shared/ai/embeddings'
import { z } from 'zod'
import { callStructuredTool } from '../../ai/agent-loop'
import { withFanout } from '../fanout'
import type { AgentContext, AgentDefinition } from '../registry'
import type { SearchKnowledgeResult } from '../tools/search-knowledge'
import { researchTopicAgent } from './research-topic'

/** Passages fetched for screening. Screening is cheap; this is about the answer's context. */
export const TRIAGE_SEARCH_LIMIT = 12
/** Longest passage text handed to the screen (the state is billed per token). */
export const TRIAGE_PASSAGE_CHARS = 1_500
/** Keep a passage when P(it helps answer the question) ≥ this. */
export const RELEVANCE_THRESHOLD = 0.5
/**
 * Below this confidence the `answerable` question did not settle the case, and the full agent
 * takes it. Noul confidence is `|2p − 1|`, so 0.4 means p between 0.3 and 0.7 escalates.
 */
export const ESCALATE_BELOW_CONFIDENCE = 0.4
const ANSWER_MAX_TOKENS = 4_096
export const SUBMIT_TRIAGE_ANSWER_TOOL = 'submit_answer'

const NOT_COVERED =
  'The knowledge base does not appear to cover this question. Nothing in the documents searched answers it.'

interface Passage {
  documentId: string
  title: string
  passage: number
  text: string
}

const answerSchema = z.object({
  answer: z.string().min(1).describe('The answer in Markdown, attributing claims to documents.'),
  documentIds: z
    .array(z.string())
    .max(RESEARCH_TOPIC_MAX_CITATIONS)
    .describe('The documentId of every document the answer actually used.'),
})

export const triageResearchAgent: AgentDefinition<TriageResearchInput, TriageResearchOutput> = {
  meta: {
    key: 'triage-research',
    title: 'Triage research',
    description:
      'Answers a question from the knowledge base by screening search hits with typed decisions (ctx.decide), opening only what is relevant, and escalating to the full research agent when the screen cannot settle it.',
    inputSchema: triageResearchInputSchema,
    outputSchema: triageResearchOutputSchema,
    promptKey: 'triage-research',
    // One run per question, and nothing shared between two of them — so any number may run at
    // once, and `POST /runs/batch` takes a file of questions. The one built-in non-exclusive agent.
    exclusive: false,
  },

  async run(ctx: AgentContext<TriageResearchInput>) {
    const question = ctx.input.question.trim()

    // 1. Search — frozen by `once`, so every attempt screens the same list.
    await ctx.step('search', 'Searching the knowledge base', 'running')
    const passages = await ctx.once('triage:search', () => search(ctx, question))
    await ctx.step('search', 'Searching the knowledge base', 'done', `${passages.length} passages`)
    await ctx.checkCancelled()
    if (passages.length === 0) return notCovered(ctx, passages, [])

    // 2. Screen every passage in one decision.
    await ctx.step('screen', 'Screening passages for relevance', 'running')
    const screen = await ctx.decide.sift('relevant', {
      items: passages,
      context: { question },
      instructions:
        'Does this passage contain information that helps answer `context.question`? A passage that only shares words with the question, or is about a different subject, does not.',
      criteria: {
        true: 'States facts, rules or figures that bear directly on the question',
        false: 'Unrelated, or related only by vocabulary',
      },
      describe: p => ({ document: p.title, text: p.text }),
      threshold: RELEVANCE_THRESHOLD,
    })
    await ctx.step(
      'screen',
      'Screening passages for relevance',
      'done',
      `${screen.kept.length} of ${passages.length} kept`
    )
    await ctx.checkCancelled()
    if (screen.kept.length === 0) return notCovered(ctx, passages, screen.p)

    // 3. Are the kept passages enough?
    const triage = await ctx.decide('answerable', {
      state: { question, passages: screen.kept.map(p => ({ document: p.title, text: p.text })) },
      questions: {
        answerable: {
          type: 'noul',
          instructions:
            'Taken together, do `passages` contain enough information to answer `question` without guessing?',
          criteria: {
            true: 'The passages state the answer, or everything needed to derive it',
            false: 'The answer is missing, partial, or would have to be assumed',
          },
        },
      },
    })
    const answerable = triage.answers.answerable
    const p = answerable?.noul ?? 0
    const confidence = answerable?.confidence ?? 0

    // 4. Route — code, not a prompt.
    if (confidence < ESCALATE_BELOW_CONFIDENCE) return escalate(ctx, question, passages, screen)
    if (p < 0.5) return notCovered(ctx, passages, screen.p)
    return answer(ctx, question, passages, screen)
  },
}

async function search(ctx: AgentContext<TriageResearchInput>, query: string): Promise<Passage[]> {
  const tool = ctx.tools.find(t => t.name === KNOWLEDGE_TOOLS.search)
  if (!tool?.handler) throw new Error('triage-research: the search_knowledge tool is unavailable')
  const input = { query, limit: TRIAGE_SEARCH_LIMIT }
  await ctx.emit({ type: 'tool.start', data: { name: tool.name, input } })
  const text = await tool.handler(input)
  let result: Partial<SearchKnowledgeResult> = {}
  try {
    result = JSON.parse(text) as SearchKnowledgeResult
  } catch {
    // A prose answer (an unavailable provider) has no passages: the run reports "not covered".
  }
  const passages: Passage[] = (result.documents ?? []).flatMap(doc =>
    doc.passages.map(p => ({
      documentId: doc.documentId,
      title: doc.title,
      passage: p.passage,
      text: p.text.slice(0, TRIAGE_PASSAGE_CHARS),
    }))
  )
  await ctx.emit({
    type: 'tool.end',
    data: { name: tool.name, result: { passagesReturned: passages.length } },
  })
  return passages
}

type Screen = { kept: Passage[]; p: number[] }

async function answer(
  ctx: AgentContext<TriageResearchInput>,
  question: string,
  passages: Passage[],
  screen: Screen
): Promise<TriageResearchOutput> {
  await ctx.step('answer', 'Writing the answer', 'running')
  // `rerun`: a pure model call, so a live replay asks again and a prompt change shows.
  const result = await ctx.once(
    'triage:answer',
    async () => {
      const context = screen.kept
        .map(
          p => `<passage documentId="${p.documentId}" title="${p.title}">\n${p.text}\n</passage>`
        )
        .join('\n\n')
      return callStructuredTool(ctx.chat.client, {
        model: ctx.chat.model,
        maxTokens: Math.min(ctx.chat.maxOutputTokens, ANSWER_MAX_TOKENS),
        system: await ctx.prompt(),
        messages: [{ role: 'user', content: `${context}\n\nQuestion: ${question}` }],
        tool: {
          name: SUBMIT_TRIAGE_ANSWER_TOOL,
          description: 'Submit the answer and the documents it used. Call exactly once.',
          schema: answerSchema,
        },
      })
    },
    { replay: 'rerun' }
  )
  // Citations only from what the screen kept — a model-supplied id outside it is dropped.
  const titles = new Map(screen.kept.map(p => [p.documentId, p.title]))
  const citations = [...new Set(result.documentIds)]
    .filter(id => titles.has(id))
    .map(documentId => ({ documentId, title: titles.get(documentId) ?? '' }))
  await ctx.emit({ type: 'text', data: { text: result.answer } })
  await ctx.step('answer', 'Writing the answer', 'done', `${citations.length} sources`)
  await screenArtifact(ctx, passages, screen.p)
  return {
    answer: result.answer,
    citations,
    route: 'answered',
    screened: passages.length,
    kept: screen.kept.length,
  }
}

async function notCovered(
  ctx: AgentContext<TriageResearchInput>,
  passages: Passage[],
  p: number[]
): Promise<TriageResearchOutput> {
  await ctx.emit({ type: 'text', data: { text: NOT_COVERED } })
  if (passages.length > 0) await screenArtifact(ctx, passages, p)
  return {
    answer: NOT_COVERED,
    citations: [],
    route: 'not_covered',
    screened: passages.length,
    kept: p.filter(x => x >= RELEVANCE_THRESHOLD).length,
  }
}

/**
 * The full agent for the case the questions could not settle: `research-topic`'s own body, on its
 * own prompt, sharing this run's context (tools, checkpoint, approvals, once). Its output is mapped
 * onto this agent's.
 */
async function escalate(
  ctx: AgentContext<TriageResearchInput>,
  question: string,
  passages: Passage[],
  screen: Screen
): Promise<TriageResearchOutput> {
  await ctx.step('escalate', 'Unsure — handing over to the research agent', 'running')
  await screenArtifact(ctx, passages, screen.p)
  // NOT a scope: `research-topic` resumes its tool loop from the run's checkpoint, and a
  // scope has none. Its keys share this run's namespace, and none of them is a `triage:*` key.
  const full = await researchTopicAgent.run(
    withFanout({
      ...ctx,
      input: { topic: question },
      prompt: vars => ctx.prompt(vars, 'research-topic'),
    })
  )
  await ctx.step('escalate', 'Unsure — handing over to the research agent', 'done')
  return {
    answer: full.answer,
    citations: full.citations,
    route: 'escalated',
    screened: passages.length,
    kept: screen.kept.length,
  }
}

/** Every passage, kept or skipped, with its probability — the audit a reviewer opens first. */
async function screenArtifact(
  ctx: AgentContext<TriageResearchInput>,
  passages: Passage[],
  p: number[]
) {
  await ctx.artifact({
    key: 'triage:screen',
    title: 'Relevance screen',
    description: `Kept when P(relevant) ≥ ${RELEVANCE_THRESHOLD}.`,
    data: {
      kind: 'table',
      columns: [
        { key: 'document', label: 'Document' },
        { key: 'passage', label: 'Passage', align: 'right' },
        { key: 'p', label: 'P(relevant)', align: 'right' },
        { key: 'kept', label: 'Kept' },
      ],
      rows: passages.map((passage, i) => ({
        document: passage.title,
        passage: passage.passage,
        p: (p[i] ?? 0).toFixed(2),
        kept: (p[i] ?? 0) >= RELEVANCE_THRESHOLD ? 'yes' : 'no',
      })),
    },
  })
}
