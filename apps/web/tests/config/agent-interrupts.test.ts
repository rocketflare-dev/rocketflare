/**
 * The human-in-the-loop contracts (issue #17), tested where they are cheapest to test: pure, no
 * database, no Worker. Three of these are guarding a specific way this feature can fail silently.
 *
 * - **`AGENT_RESUME_EVENT`** — Cloudflare rejects a `.` in a Workflow event type with
 *   `workflow.invalid_event_type`, and NOTHING else in the suite would catch it: the Node
 *   harness's `createFakeWorkflowStep` never validates the name. A bad one first surfaces as a
 *   parked run that can never be resumed, in production, on the first approval anyone ever gives.
 * - **`INTERRUPT_REJECTION`** — whether declining stops the run or goes back to the model is the
 *   difference between "no, don't send that email" and "the agent sent it anyway".
 * - **the payload validators** — the route and the UI both call `interruptPayloadSchema(spec)`, so
 *   a client-side pass and the server's 400 agree by construction, and this is what proves it.
 */
import {
  ACTIVE_RUN_STATUSES,
  AGENT_RESUME_EVENT,
  AGENT_RUN_EVENT_DATA,
  AGENT_RUN_EVENT_TYPES,
  agentRunStatusSchema,
  CLAIMABLE_RUN_STATUSES,
  isRunActive,
  WORKFLOW_EVENT_TYPE_PATTERN,
} from '@rocketflare/shared/ai/agents'
import {
  ARTIFACT_JSON_MAX_CHARS,
  ARTIFACT_TABLE_MAX_ROWS,
  agentArtifactSchema,
} from '@rocketflare/shared/ai/artifacts'
import {
  AGENT_INTERRUPT_KINDS,
  type AgentInterruptSpec,
  aguiReasonFor,
  formValuesSchemaFor,
  INTERRUPT_REJECTION,
  interruptPayloadSchema,
  rejectionFor,
} from '@rocketflare/shared/ai/interrupts'
import { describe, expect, it } from 'vitest'

const RUN = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ARTIFACT = '33333333-3333-4333-8333-333333333333'
const AT = new Date('2026-09-16T09:00:00.000Z')

describe('the Workflow resume event (T8)', () => {
  it('is a legal Cloudflare Workflows event type', () => {
    expect(AGENT_RESUME_EVENT).toMatch(WORKFLOW_EVENT_TYPE_PATTERN)
  })

  it('is spelled with a hyphen, because a dot is rejected at runtime', () => {
    expect(AGENT_RESUME_EVENT).toBe('agent-resume')
    expect('agent.resume').not.toMatch(WORKFLOW_EVENT_TYPE_PATTERN)
  })

  it('rejects the other shapes somebody might reach for', () => {
    for (const bad of ['agent resume', 'agent/resume', '', 'a'.repeat(101), 'agent:resume']) {
      expect(bad).not.toMatch(WORKFLOW_EVENT_TYPE_PATTERN)
    }
  })
})

describe('run statuses', () => {
  it('appends `awaiting_input` last, because the enum mirrors a text column', () => {
    expect(agentRunStatusSchema.options.at(-1)).toBe('awaiting_input')
  })

  it('treats a parked run as active — it still holds the exclusive slot', () => {
    expect(isRunActive('awaiting_input')).toBe(true)
    expect([...ACTIVE_RUN_STATUSES]).toEqual(['queued', 'running', 'awaiting_input'])
  })

  it('keeps the claimable list narrower: the answer is the transition (T4)', () => {
    // The resolve route flips `awaiting_input → running` BEFORE nudging, so a claim never has to
    // see a parked row. Widening this is how a restarted instance claims an unanswered run.
    expect([...CLAIMABLE_RUN_STATUSES]).toEqual(['queued', 'running'])
    expect(CLAIMABLE_RUN_STATUSES as readonly string[]).not.toContain('awaiting_input')
  })
})

describe('event payload schemas', () => {
  it('has a schema for every event type — no more lenient local copies', () => {
    expect(Object.keys(AGENT_RUN_EVENT_DATA).sort()).toEqual([...AGENT_RUN_EVENT_TYPES].sort())
  })

  it('lets a tool row carry whatever the agent attached beside the name', () => {
    const parsed = AGENT_RUN_EVENT_DATA['tool.end'].parse({
      name: 'submit_summary',
      keyPoints: 4,
      isError: false,
    })
    expect(parsed).toMatchObject({ name: 'submit_summary', keyPoints: 4, isError: false })
  })
})

describe('INTERRUPT_REJECTION', () => {
  it('covers every kind', () => {
    expect(Object.keys(INTERRUPT_REJECTION).sort()).toEqual([...AGENT_INTERRUPT_KINDS].sort())
  })

  it('makes a declined approval stop the run, and every other decline an answer', () => {
    expect(INTERRUPT_REJECTION.approval).toBe('cancel_run')
    expect(INTERRUPT_REJECTION.choice).toBe('tell_model')
    expect(INTERRUPT_REJECTION.input).toBe('tell_model')
    expect(INTERRUPT_REJECTION.form).toBe('tell_model')
  })

  it('lets one ask override its kind’s default', () => {
    const spec: AgentInterruptSpec = { kind: 'approval', message: 'Retry?', onReject: 'tell_model' }
    expect(rejectionFor(spec)).toBe('tell_model')
    expect(rejectionFor({ kind: 'approval', message: 'Delete?' })).toBe('cancel_run')
    expect(rejectionFor({ kind: 'input', message: 'Subject?', multiline: false })).toBe(
      'tell_model'
    )
  })
})

describe('the AG-UI reason', () => {
  it('is `tool_call` only when an approval gates a named call', () => {
    expect(aguiReasonFor('approval')).toBe('confirmation')
    expect(aguiReasonFor('approval', 'call_1')).toBe('tool_call')
    expect(aguiReasonFor('choice')).toBe('input_required')
    // A toolCallId on a non-approval does not change the reason.
    expect(aguiReasonFor('form', 'call_1')).toBe('input_required')
  })
})

describe('interruptPayloadSchema — approval', () => {
  const plain: AgentInterruptSpec = { kind: 'approval', message: 'Send it?' }
  const editable: AgentInterruptSpec = {
    kind: 'approval',
    message: 'Send it?',
    tool: { name: 'send_email', input: { to: 'a@b.c' }, allowEdits: true },
  }

  it('accepts a bare approval, with or without a note', () => {
    expect(interruptPayloadSchema(plain).parse({})).toEqual({})
    expect(interruptPayloadSchema(plain).parse({ note: 'looks right' })).toEqual({
      note: 'looks right',
    })
  })

  it('refuses `editedInput` unless the ask allowed edits — a client that can edit args can call anything', () => {
    const refused = interruptPayloadSchema(plain).safeParse({ editedInput: { to: 'x@y.z' } })
    expect(refused.success).toBe(false)
    expect(interruptPayloadSchema(editable).parse({ editedInput: { to: 'x@y.z' } })).toEqual({
      editedInput: { to: 'x@y.z' },
    })
  })
})

describe('interruptPayloadSchema — choice', () => {
  const spec: AgentInterruptSpec = {
    kind: 'choice',
    message: 'Which customer?',
    options: [
      { value: 'acme', label: 'Acme' },
      { value: 'globex', label: 'Globex' },
    ],
    allowOther: false,
  }

  it('narrows the answer to the offered options', () => {
    expect(interruptPayloadSchema(spec).parse({ value: 'acme' })).toEqual({ value: 'acme' })
    expect(interruptPayloadSchema(spec).safeParse({ value: 'initech' }).success).toBe(false)
  })

  it('opens up when the ask said `allowOther`', () => {
    const open = interruptPayloadSchema({ ...spec, allowOther: true })
    expect(open.parse({ value: 'initech' })).toEqual({ value: 'initech' })
  })
})

describe('interruptPayloadSchema — input', () => {
  it('requires non-empty text and honours the ask’s own cap', () => {
    const spec: AgentInterruptSpec = {
      kind: 'input',
      message: 'Subject line?',
      multiline: false,
      maxLength: 10,
    }
    expect(interruptPayloadSchema(spec).parse({ text: '  hello  ' })).toEqual({ text: 'hello' })
    expect(interruptPayloadSchema(spec).safeParse({ text: '   ' }).success).toBe(false)
    expect(interruptPayloadSchema(spec).safeParse({ text: 'x'.repeat(11) }).success).toBe(false)
  })
})

describe('interruptPayloadSchema — form', () => {
  const spec: AgentInterruptSpec = {
    kind: 'form',
    message: 'Confirm the details',
    fields: [
      { name: 'subject', label: 'Subject', type: 'text', required: true },
      { name: 'copies', label: 'Copies', type: 'number', required: false, min: 1, max: 5 },
      {
        name: 'tone',
        label: 'Tone',
        type: 'select',
        required: true,
        options: [
          { value: 'formal', label: 'Formal' },
          { value: 'casual', label: 'Casual' },
        ],
      },
      { name: 'urgent', label: 'Urgent', type: 'boolean', required: false },
    ],
  }
  const schema = interruptPayloadSchema(spec)

  it('accepts a complete answer', () => {
    expect(schema.parse({ values: { subject: 'Hi', tone: 'formal', copies: 2 } })).toEqual({
      values: { subject: 'Hi', tone: 'formal', copies: 2 },
    })
  })

  it('enforces required, the option list and the numeric bounds', () => {
    expect(schema.safeParse({ values: { tone: 'formal' } }).success).toBe(false)
    expect(schema.safeParse({ values: { subject: 'Hi', tone: 'shouty' } }).success).toBe(false)
    expect(schema.safeParse({ values: { subject: 'Hi', tone: 'formal', copies: 9 } }).success).toBe(
      false
    )
    expect(schema.safeParse({ values: { subject: '  ', tone: 'formal' } }).success).toBe(false)
  })

  it('refuses a value the form never asked for', () => {
    expect(
      schema.safeParse({ values: { subject: 'Hi', tone: 'formal', isAdmin: true } }).success
    ).toBe(false)
  })

  it('is the same function the UI validates its draft with', () => {
    // `formValuesSchemaFor` is what the panel calls; `interruptPayloadSchema` wraps it. One
    // implementation, so a green client-side pass can never become a 400.
    expect(formValuesSchemaFor(spec.kind === 'form' ? spec.fields : []).safeParse({}).success).toBe(
      false
    )
  })
})

describe('artifacts', () => {
  const base = {
    id: ARTIFACT,
    tenantId: TENANT,
    runId: RUN,
    key: 'draft',
    title: 'Draft',
    description: null,
    createdAt: AT,
    updatedAt: AT,
  }

  it('keeps the kind column and the data discriminant in step', () => {
    expect(
      agentArtifactSchema.safeParse({
        ...base,
        kind: 'markdown',
        data: { kind: 'markdown', markdown: 'hi' },
      }).success
    ).toBe(true)
    expect(
      agentArtifactSchema.safeParse({
        ...base,
        kind: 'json',
        data: { kind: 'markdown', markdown: 'hi' },
      }).success
    ).toBe(false)
  })

  it('carries ids for a document or a file, never the bytes', () => {
    const parsed = agentArtifactSchema.parse({
      ...base,
      kind: 'document',
      data: { kind: 'document', documentId: RUN },
    })
    expect(parsed.data).toEqual({ kind: 'document', documentId: RUN })
  })

  it('caps inline payloads in the contract rather than in the column', () => {
    const tooBig = { a: 'x'.repeat(ARTIFACT_JSON_MAX_CHARS) }
    expect(
      agentArtifactSchema.safeParse({ ...base, kind: 'json', data: { kind: 'json', json: tooBig } })
        .success
    ).toBe(false)
    expect(
      agentArtifactSchema.safeParse({
        ...base,
        kind: 'table',
        data: {
          kind: 'table',
          columns: [{ key: 'a', label: 'A' }],
          rows: Array.from({ length: ARTIFACT_TABLE_MAX_ROWS + 1 }, () => ({ a: 1 })),
        },
      }).success
    ).toBe(false)
  })
})
