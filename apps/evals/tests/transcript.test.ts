/** AG-UI events and run events → transcripts (D33): output, tool calls and what retrieval returned. */
import type { KitAguiEvent } from '@rocketflare/shared/ai/agui'
import { describe, expect, it } from 'vitest'
import { parseJudgeJson } from '../kit/judge-harness'
import { transcriptFromAgui, transcriptFromRunEvents } from '../kit/transcript'

const SEARCH = JSON.stringify({
  documents: [{ title: 'Refund policy', passages: [{ text: 'Refunds within 30 days.' }] }],
})

describe('transcriptFromAgui', () => {
  it('joins the text across turns, pairs tool calls and reads retrieval from the results', () => {
    const events = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      {
        type: 'CUSTOM',
        name: 'kit.chat.ids',
        value: { provider: 'anthropic', model: 'claude-x' },
      },
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'search_knowledge' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"query":"refund"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 'c1', content: SEARCH, role: 'tool' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'Thirty ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'days.' },
    ] as unknown as KitAguiEvent[]
    const t = transcriptFromAgui(events, 'How long?')
    expect(t.output).toBe('Thirty days.')
    expect(t.provider).toBe('anthropic')
    expect(t.model).toBe('claude-x')
    expect(t.toolCalls).toEqual([
      { id: 'c1', name: 'search_knowledge', arguments: { query: 'refund' }, result: SEARCH },
    ])
    expect(t.retrieved).toEqual([{ title: 'Refund policy', text: 'Refunds within 30 days.' }])
    expect(t.events.map(e => e.type)).toEqual(['message', 'tool_call', 'tool_result', 'message'])
  })

  it('surfaces a RUN_ERROR', () => {
    const t = transcriptFromAgui(
      [{ type: 'RUN_ERROR', message: 'rate limited' }] as unknown as KitAguiEvent[],
      'q'
    )
    expect(t.error).toBe('rate limited')
  })
})

describe('transcriptFromRunEvents', () => {
  it('pairs tool.start with tool.end and keeps the settled output', () => {
    const t = transcriptFromRunEvents(
      [
        { type: 'step', data: { key: 's', label: 'x', status: 'running' } },
        {
          type: 'tool.start',
          data: { name: 'search_knowledge', input: { query: 'r' }, toolCallId: 'k' },
        },
        {
          type: 'tool.end',
          data: { name: 'search_knowledge', result: JSON.parse(SEARCH), toolCallId: 'k' },
        },
      ],
      { topic: 'refunds' },
      { answer: 'Thirty days.' }
    )
    expect(t.toolCalls.map(c => [c.id, c.name])).toEqual([['k', 'search_knowledge']])
    expect(t.retrieved).toHaveLength(1)
    expect(t.output).toEqual({ answer: 'Thirty days.' })
  })
})

describe('parseJudgeJson', () => {
  it('reads bare, fenced and embedded JSON, and hands anything else back as text', () => {
    expect(parseJudgeJson('{"verdict":"pass"}')).toEqual({ verdict: 'pass' })
    expect(parseJudgeJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJudgeJson('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 })
    expect(parseJudgeJson('no json here')).toBe('no json here')
  })
})
