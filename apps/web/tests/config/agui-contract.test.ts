/**
 * The AG-UI version pin is a wire-protocol pin: `@ag-ui/core`'s schemas ARE the format the server
 * emits, so a bump can rename a field and silently change what every adopted copy puts on the wire.
 * This file is what turns the pin into a gate — one sample of every event the kit emits, and every
 * kit CUSTOM payload, parsed with the installed schemas. If a bump breaks one of these, the
 * protocol changed and the upgrade note has to say so.
 */
import { decode as decodeProto, encode as encodeProto } from '@ag-ui/proto'
import {
  chatRunResultSchema,
  KIT_AGUI_EVENT_TYPES,
  KIT_CUSTOM_EVENTS,
  kitAguiEventSchema,
  kitCustomPayloadSchema,
  kitRunAgentInputSchema,
  parseKitCustom,
  readRunAgentTail,
  toAguiInterrupt,
} from '@rocketflare/shared/ai/agui'
import type { AgentRunInterrupt } from '@rocketflare/shared/ai/interrupts'
import { describe, expect, it } from 'vitest'
import { createAguiEncoder, PROTO_UNSUPPORTED_EVENTS } from '@/api/services/ai/agui'

const THREAD = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const MESSAGE = '33333333-3333-4333-8333-333333333333'
const USER_MESSAGE = '44444444-4444-4444-8444-444444444444'

const USAGE = { inputTokens: 12, outputTokens: 34 }
const RUN_ID = '66666666-6666-4666-8666-666666666666'
const INTERRUPT = '77777777-7777-4777-8777-777777777777'
const ARTIFACT = '88888888-8888-4888-8888-888888888888'
const EVENT = '99999999-9999-4999-8999-999999999999'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const AT = new Date('2026-09-16T09:00:00.000Z')
const EXPIRES = new Date('2026-09-23T09:00:00.000Z')

/** A pending approval, as `agent_run_interrupts` holds it (issue #17). */
const INTERRUPT_ROW: AgentRunInterrupt = {
  id: INTERRUPT,
  tenantId: TENANT,
  runId: RUN_ID,
  key: 'index-summary',
  kind: 'approval',
  reason: 'tool_call',
  message: 'Add this summary to the knowledge base?',
  toolCallId: 'call_2',
  responseSchema: { type: 'object', properties: { note: { type: 'string' } } },
  spec: {
    kind: 'approval',
    message: 'Add this summary to the knowledge base?',
    tool: { name: 'ingest_text', input: { title: 'Q3 review' }, allowEdits: false },
  },
  status: 'pending',
  payload: null,
  expiresAt: EXPIRES,
  resolvedAt: null,
  resolvedByUserId: null,
  createdAt: AT,
  updatedAt: AT,
}

/** One sample per emitted event type — the subset `kitAguiEventSchema` declares. */
const SAMPLES: Record<string, unknown> = {
  RUN_STARTED: { type: 'RUN_STARTED', threadId: THREAD, runId: RUN },
  RUN_FINISHED: {
    type: 'RUN_FINISHED',
    threadId: THREAD,
    runId: RUN,
    result: { conversationId: THREAD, messageId: MESSAGE, usage: USAGE, stopReason: 'end_turn' },
  },
  RUN_ERROR: { type: 'RUN_ERROR', message: 'The provider is unavailable', code: 'unavailable' },
  STEP_STARTED: { type: 'STEP_STARTED', stepName: 'search' },
  STEP_FINISHED: { type: 'STEP_FINISHED', stepName: 'search' },
  TEXT_MESSAGE_START: { type: 'TEXT_MESSAGE_START', messageId: MESSAGE, role: 'assistant' },
  TEXT_MESSAGE_CONTENT: { type: 'TEXT_MESSAGE_CONTENT', messageId: MESSAGE, delta: 'hello' },
  TEXT_MESSAGE_END: { type: 'TEXT_MESSAGE_END', messageId: MESSAGE },
  TOOL_CALL_START: {
    type: 'TOOL_CALL_START',
    toolCallId: 'call_1',
    toolCallName: 'search_knowledge',
    parentMessageId: MESSAGE,
  },
  TOOL_CALL_ARGS: { type: 'TOOL_CALL_ARGS', toolCallId: 'call_1', delta: '{"query":"x"}' },
  TOOL_CALL_END: { type: 'TOOL_CALL_END', toolCallId: 'call_1' },
  TOOL_CALL_RESULT: {
    type: 'TOOL_CALL_RESULT',
    messageId: MESSAGE,
    toolCallId: 'call_1',
    content: '{"documents":[]}',
    role: 'tool',
  },
  STATE_SNAPSHOT: {
    type: 'STATE_SNAPSHOT',
    snapshot: { conversationId: THREAD, provider: 'anthropic', model: 'm', tools: [] },
  },
  MESSAGES_SNAPSHOT: {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: USER_MESSAGE, role: 'user', content: 'hello' }],
  },
  CUSTOM: {
    type: 'CUSTOM',
    name: KIT_CUSTOM_EVENTS.usage,
    value: { usage: USAGE },
  },
}

/** One sample per kit CUSTOM name — the namespace where every kit-specific semantic lives. */
const CUSTOM_SAMPLES: Record<string, unknown> = {
  [KIT_CUSTOM_EVENTS.chatIds]: {
    conversationId: THREAD,
    userMessageId: USER_MESSAGE,
    assistantMessageId: MESSAGE,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
  },
  [KIT_CUSTOM_EVENTS.usage]: { usage: USAGE },
  [KIT_CUSTOM_EVENTS.agentStep]: { key: 'search', label: 'Searching', status: 'running' },
  [KIT_CUSTOM_EVENTS.agentRetry]: { message: 'rate limited', attempt: 1 },
  [KIT_CUSTOM_EVENTS.notice]: { code: 'workers_ai_no_token_streaming' },
  [KIT_CUSTOM_EVENTS.document]: {
    card: {
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Onboarding guide',
      typeLabel: 'PDF',
      contentType: 'application/pdf',
      status: 'indexed',
      excerpt: 'Everyone joining reads this first.',
      passages: 4,
      sizeBytes: 2048,
      fileId: null,
      href: '/documents/55555555-5555-4555-8555-555555555555',
    },
  },
  [KIT_CUSTOM_EVENTS.agentInterrupt]: { interrupt: INTERRUPT_ROW },
  [KIT_CUSTOM_EVENTS.agentInterruptResolved]: {
    interruptId: INTERRUPT,
    key: 'index-summary',
    kind: 'approval',
    status: 'resolved',
    resolvedByUserId: USER,
  },
  [KIT_CUSTOM_EVENTS.agentSteering]: {
    note: {
      eventId: EVENT,
      text: 'Focus on the European numbers.',
      authorUserId: USER,
      at: AT,
    },
  },
  [KIT_CUSTOM_EVENTS.agentArtifact]: {
    artifact: {
      id: ARTIFACT,
      tenantId: TENANT,
      runId: RUN_ID,
      key: 'draft-email',
      kind: 'markdown',
      title: 'Draft email',
      description: null,
      data: { kind: 'markdown', markdown: 'Dear all,' },
      createdAt: AT,
      updatedAt: AT,
    },
  },
}

describe('AG-UI contract', () => {
  it('has a sample for every declared event type', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...KIT_AGUI_EVENT_TYPES].sort())
  })

  it.each(Object.entries(SAMPLES))('parses %s through the installed schemas', (_type, sample) => {
    const parsed = kitAguiEventSchema.safeParse(sample)
    expect(parsed.success ? null : parsed.error.issues).toBeNull()
  })

  it('has a sample for every kit CUSTOM name', () => {
    expect(Object.keys(CUSTOM_SAMPLES).sort()).toEqual(Object.keys(kitCustomPayloadSchema).sort())
    expect(Object.keys(kitCustomPayloadSchema).sort()).toEqual(
      Object.values(KIT_CUSTOM_EVENTS).sort()
    )
  })

  it.each(Object.entries(CUSTOM_SAMPLES))('reads the %s payload back', (name, value) => {
    const event = kitAguiEventSchema.parse({ type: 'CUSTOM', name, value })
    expect(parseKitCustom(name as keyof typeof kitCustomPayloadSchema, event)).toEqual(value)
  })

  it('ignores a CUSTOM event whose payload does not match its name', () => {
    const event = kitAguiEventSchema.parse({
      type: 'CUSTOM',
      name: KIT_CUSTOM_EVENTS.usage,
      value: { nonsense: true },
    })
    expect(parseKitCustom(KIT_CUSTOM_EVENTS.usage, event)).toBeUndefined()
    expect(parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)).toBeUndefined()
  })

  it('rejects an event type the kit does not emit', () => {
    // The subset is the point: a full-union parse would accept this.
    expect(kitAguiEventSchema.safeParse({ type: 'STATE_DELTA', delta: [] }).success).toBe(false)
  })

  it('describes a chat turn in RUN_FINISHED.result', () => {
    const finished = kitAguiEventSchema.parse(SAMPLES.RUN_FINISHED)
    if (finished.type !== 'RUN_FINISHED') throw new Error('unreachable')
    expect(chatRunResultSchema.parse(finished.result)).toMatchObject({ messageId: MESSAGE })
  })
})

describe('a parked run’s interrupt outcome', () => {
  // `RUN_FINISHED { outcome: { type: 'interrupt', interrupts } }` is the ENTIRE reason a
  // third-party AG-UI client can answer a kit run with zero kit-specific code. If protobuf could
  // not carry it, `PROTO_UNSUPPORTED_EVENTS` (which drops by event TYPE) would have to drop every
  // RUN_FINISHED on that wire, and phases 5–6 of the HITL work would need a `kit.` CUSTOM fallback
  // instead. So it is proven on BOTH transports, here, before anything is built on it.
  //
  // And it is asserted on the DECODED value, never on "encode did not throw": the discriminator is
  // `'interrupt'`, not `'interrupted'`, and getting it wrong makes `@ag-ui/proto` log
  // "Malformed event detected, falling back to unvalidated event" and write a frame with the
  // outcome SILENTLY DROPPED.
  const interrupt = toAguiInterrupt(INTERRUPT_ROW)
  const finished = {
    type: 'RUN_FINISHED',
    threadId: RUN_ID,
    runId: RUN_ID,
    outcome: { type: 'interrupt', interrupts: [interrupt] },
  }

  it('maps a kit row onto the protocol’s own Interrupt', () => {
    expect(interrupt).toEqual({
      id: INTERRUPT,
      reason: 'tool_call',
      message: 'Add this summary to the knowledge base?',
      toolCallId: 'call_2',
      responseSchema: { type: 'object', properties: { note: { type: 'string' } } },
      expiresAt: EXPIRES.toISOString(),
      metadata: { kind: 'approval', key: 'index-summary' },
    })
  })

  it('parses through the kit’s own event union', () => {
    const parsed = kitAguiEventSchema.safeParse(finished)
    expect(parsed.success ? null : parsed.error.issues).toBeNull()
  })

  it('survives the SSE transport intact', () => {
    const encoder = createAguiEncoder('text/event-stream')
    expect(encoder.binary).toBe(false)
    const bytes = encoder.encode(finished as never)
    if (!bytes) throw new Error('SSE dropped RUN_FINISHED')
    const frame = new TextDecoder().decode(bytes)
    // Spec AG-UI SSE is `data:` only — the type lives inside the JSON.
    expect(frame.startsWith('data: ')).toBe(true)
    expect(frame).not.toContain('event:')
    const decoded = kitAguiEventSchema.parse(JSON.parse(frame.slice('data: '.length).trim()))
    if (decoded.type !== 'RUN_FINISHED') throw new Error('unreachable')
    expect(decoded.outcome).toEqual({ type: 'interrupt', interrupts: [interrupt] })
  })

  it('survives the protobuf transport intact', () => {
    const decoded = decodeProto(encodeProto(finished as never)) as {
      type?: string
      outcome?: unknown
    }
    expect(decoded.type).toBe('RUN_FINISHED')
    // Every field, not just the id: a partial message is exactly what a silent fallback produces.
    expect(decoded.outcome).toEqual({ type: 'interrupt', interrupts: [interrupt] })
  })

  it('is not in the list of events protobuf cannot carry', () => {
    expect(PROTO_UNSUPPORTED_EVENTS).not.toContain('RUN_FINISHED')
  })
})

describe('the protobuf transport', () => {
  it('round-trips every emitted event except the ones declared unsupported', () => {
    // A round trip, not "does `encode` throw": `@ag-ui/proto@0.0.59` has no message for
    // TOOL_CALL_RESULT, and its encoder answers an EMPTY frame for it rather than failing — which
    // no client can decode. That is why the encoder drops those events instead of writing them.
    const unsupported = Object.entries(SAMPLES)
      .filter(([, sample]) => {
        try {
          const decoded = decodeProto(encodeProto(sample as never)) as { type?: string }
          return decoded.type !== (sample as { type: string }).type
        } catch {
          return true
        }
      })
      .map(([type]) => type)
    // When upstream gains the missing message, this fails and the list shrinks deliberately.
    expect(unsupported.sort()).toEqual([...PROTO_UNSUPPORTED_EVENTS].sort())
  })
})

describe('RunAgentInput', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    threadId: THREAD,
    runId: RUN,
    state: {},
    messages: [{ id: USER_MESSAGE, role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    ...over,
  })

  it('accepts a well-formed tail', () => {
    const parsed = kitRunAgentInputSchema.parse(input())
    expect(readRunAgentTail(parsed)).toEqual({ ok: true, id: USER_MESSAGE, content: 'hello' })
  })

  it('requires a uuid threadId and at least one message', () => {
    expect(kitRunAgentInputSchema.safeParse(input({ threadId: 'nope' })).success).toBe(false)
    expect(kitRunAgentInputSchema.safeParse(input({ messages: [] })).success).toBe(false)
  })

  it('refuses client-side tools rather than ignoring them', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({ tools: [{ name: 'x', description: 'd', parameters: {} }] })
    )
    expect(readRunAgentTail(parsed)).toEqual({ ok: false, code: 'agui_client_tools_unsupported' })
  })

  it('requires the LAST message to be a user turn', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({
        messages: [
          { id: USER_MESSAGE, role: 'user', content: 'hello' },
          { id: MESSAGE, role: 'assistant', content: 'hi' },
        ],
      })
    )
    expect(readRunAgentTail(parsed)).toEqual({ ok: false, code: 'agui_last_message_not_user' })
  })

  it('refuses content that is not a usable string', () => {
    const empty = kitRunAgentInputSchema.parse(
      input({ messages: [{ id: USER_MESSAGE, role: 'user', content: '   ' }] })
    )
    expect(readRunAgentTail(empty)).toEqual({ ok: false, code: 'agui_unsupported_content' })
  })

  it('carries `resume[]`, so a client answers an interrupt in AG-UI’s own vocabulary', () => {
    // The pause and the answer need NO new kit event: `RunAgentInputSchema` already models the
    // answer, which is what lets a third-party client drive a parked kit run.
    const parsed = kitRunAgentInputSchema.parse(
      input({ resume: [{ interruptId: INTERRUPT, status: 'resolved', payload: { note: 'go' } }] })
    )
    expect(parsed.resume).toEqual([
      { interruptId: INTERRUPT, status: 'resolved', payload: { note: 'go' } },
    ])
    expect(
      kitRunAgentInputSchema.safeParse(
        input({ resume: [{ interruptId: INTERRUPT, status: 'nope' }] })
      ).success
    ).toBe(false)
  })

  it('takes only the tail — earlier messages are the server’s business', () => {
    const parsed = kitRunAgentInputSchema.parse(
      input({
        messages: [
          { id: MESSAGE, role: 'assistant', content: 'fabricated' },
          { id: USER_MESSAGE, role: 'user', content: 'the real turn' },
        ],
      })
    )
    expect(readRunAgentTail(parsed)).toEqual({
      ok: true,
      id: USER_MESSAGE,
      content: 'the real turn',
    })
  })
})
