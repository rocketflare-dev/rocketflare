/**
 * The chat target (D33): one case → one real chat turn, IN-PROCESS, through the same route the UI
 * calls (`POST /api/chat/conversations/:id/messages` → `prepareChatTurn` → `streamChatTurn`). Driving
 * the route rather than calling `streamChatTurn` directly is deliberate: `prepareChatTurn` is where
 * the prompt, the history window and the knowledge tools are decided, and an eval that skipped it
 * would be grading a chat nobody ships.
 *
 * The case's `messages` are seeded as the thread's earlier turns, its `context` documents ingested
 * into a tenant of its own, and the whole turn runs inside `withEvalScope`, so its trace carries
 * `rocketflare.eval=true`. The AG-UI stream comes back as a transcript: the answer, the tool calls,
 * what retrieval returned, usage from the `ai_usage` ledger.
 */
import { conversationSchema } from '@rocketflare/shared/ai/chat'
import type { EvalCase } from '@rocketflare/shared/ai/evals'
import { createHarness, type Harness } from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { resolvePrompt } from '@/api/services/prompts'
import { aguiFrames } from '../../web/tests/helpers/ai'
import { request } from '../../web/tests/helpers/request'
import { caseWorld, seedHistory } from './fixtures'
import { promptHash, tenantSpend } from './spend'
import { transcriptFromAgui } from './transcript'

export function chatHarness(): Harness<EvalCase, string> {
  return createHarness<EvalCase, string>({
    name: 'rocketflare-chat',
    run: async ({ input: evalCase }) => {
      if (typeof evalCase.input !== 'string') {
        throw new Error(`case ${evalCase.id}: a chat case's input is the user's message (a string)`)
      }
      const question = evalCase.input
      const world = await caseWorld(evalCase, ['chat'])
      const started = Date.now()
      const { events, conversationId } = await withEvalScope(async () => {
        const created = await request(
          '/api/chat/conversations',
          { method: 'POST', headers: world.cookie },
          { env: world.env }
        )
        if (created.status !== 201) {
          throw new Error(
            `chat: creating the conversation answered ${created.status}: ${await created.text()}`
          )
        }
        const conversation = conversationSchema.parse(await created.json())
        await seedHistory(world, conversation.id, evalCase.messages)
        const res = await request(
          `/api/chat/conversations/${conversation.id}/messages`,
          { method: 'POST', headers: world.cookie },
          { env: world.env, json: { content: question } }
        )
        if (!res.ok) throw new Error(`chat: the turn answered ${res.status}: ${await res.text()}`)
        // Read INSIDE the scope: the stream body is still running, and its spans must carry the flag.
        return { events: await aguiFrames(res), conversationId: conversation.id }
      })
      const totalMs = Date.now() - started
      const transcript = transcriptFromAgui(events, question)
      if (transcript.error) throw new Error(`chat turn failed: ${transcript.error}`)

      const prompt = await resolvePrompt(world.db, world.tenantId, 'chat', {
        appName: world.cfg.APP_NAME,
        tenantName: world.tenantName,
        userName: '',
      })
      return {
        output: transcript.output,
        events: transcript.events,
        usage: {
          provider: transcript.provider,
          model: transcript.model,
          toolCalls: transcript.toolCalls.length,
          ...(await tenantSpend(world.db, world.tenantId)),
        },
        timings: { totalMs },
        artifacts: {
          retrieved: transcript.retrieved,
          promptKey: 'chat',
          promptHash: promptHash(prompt),
          conversationId,
        },
      }
    },
  })
}
