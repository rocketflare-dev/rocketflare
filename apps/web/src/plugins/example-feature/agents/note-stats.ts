/**
 * `example-feature.note-stats` — the agent a new note STARTS (D42). It is deliberately the
 * smallest agent there is: no model call, just the note's word and character counts, so the
 * event → trigger → run path works in a copy with no AI key and its test needs no stub.
 *
 * What it shows:
 *
 * - **`triggers`** — `eventTrigger(EXAMPLE_NOTE_CREATED_EVENT, { where, input })`: every new note
 *   whose title does not start with "draft" starts one run, built from the event's payload and
 *   validated by `inputSchema`, through the same gates as `POST /api/agents/runs`. Idempotent per
 *   (event, agent): a redelivered event answers the first run.
 * - **`bindable`** — the same agent also OPTS IN to being started by the event when a subject names
 *   it, so `GET /api/agents/bindable?event=example-feature.note.created` lists it for a picker. A
 *   real plugin offers one or the other for an event; both are here to be read.
 * - **The run reads the note itself**, under the run's tenant: the payload carries ids and the
 *   title, never the body.
 */
import {
  EXAMPLE_NOTE_CREATED_EVENT,
  EXAMPLE_NOTE_STATS_AGENT,
  EXAMPLE_NOTE_STATS_PROMPT,
  type ExampleNoteStatsOutput,
  exampleNoteStatsInputSchema,
  exampleNoteStatsOutputSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import type { z } from 'zod'
import type { PluginAgent } from '@/plugins/api'
import { agentCtx, eventBinding, eventTrigger } from '@/plugins/api'
import { getExampleNote } from '../api/notes'

type Input = z.infer<typeof exampleNoteStatsInputSchema>

export const exampleNoteStatsPrompt = {
  key: EXAMPLE_NOTE_STATS_PROMPT,
  title: 'Example note stats',
  description: 'The example plugin’s note-stats agent. It calls no model; the prompt is unused.',
  variables: ['appName', 'tenantName'],
  defaultText: 'You count the words in a note inside {{appName}} for {{tenantName}}.',
}

export const exampleNoteStatsAgent: PluginAgent<Input, ExampleNoteStatsOutput> = {
  meta: {
    key: EXAMPLE_NOTE_STATS_AGENT,
    title: 'Example note stats',
    description: 'Counts the words in a new example note. Started by example-feature.note.created.',
    inputSchema: exampleNoteStatsInputSchema,
    outputSchema: exampleNoteStatsOutputSchema,
    promptKey: EXAMPLE_NOTE_STATS_PROMPT,
    exclusive: false,
  },
  triggers: [
    eventTrigger(EXAMPLE_NOTE_CREATED_EVENT, {
      where: payload => !payload.title.toLowerCase().startsWith('draft'),
      input: payload => ({ noteId: payload.noteId }),
    }),
  ],
  bindable: [
    eventBinding(EXAMPLE_NOTE_CREATED_EVENT, { input: payload => ({ noteId: payload.noteId }) }),
  ],
  run: async runtime => {
    const ctx = agentCtx(runtime)
    const note = await getExampleNote(ctx.db, ctx.tenantId, ctx.input.noteId)
    const text = note ? `${note.title}\n${note.body}` : ''
    const words = text.split(/\s+/).filter(Boolean).length
    await ctx.step('count', 'Counted the words', 'done', `${words} words`)
    return { noteId: ctx.input.noteId, words, characters: text.length }
  },
}
