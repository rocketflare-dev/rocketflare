/**
 * Human-in-the-loop interrupts for agent runs (issue #17). An agent may suspend mid-run and wait
 * for a person: "send this email?", "which of these three customers?", "what should the subject
 * line be?". The run parks durably (`agent_runs.status = 'awaiting_input'`, the Workflow instance
 * on `step.waitForEvent`) and resumes when somebody answers.
 *
 * Three rules hold this together, and each is load-bearing:
 *
 * - **`key` is mandatory and is the idempotency.** A resumed `execute` step re-enters the agent's
 *   `run()` from the top and asks again; `UNIQUE (run_id, key)` is what makes the second ask find
 *   the first ask's ANSWER rather than creating a second row, forever.
 * - **The kinds are a closed set.** A fifth kind is one tuple entry, one payload schema and one UI
 *   branch — deliberately cheaper than adopting a JSON-Schema form generator, which would put an
 *   unbounded renderer in the browser for a surface with four shapes.
 * - **`spec` is typed and is named `spec`.** An untyped jsonb blob called `metadata` is where
 *   render bugs live: the panel that has to draw the question needs to know it is drawing a
 *   `choice` with these options, not "some object".
 *
 * **This file must not import `@ag-ui/core`** — `apps/web/tests/config/shared-imports.test.ts`
 * confines that dependency to `ai/agui.ts`, which is where `toAguiInterrupt` lives. The kit's row
 * shape is zod-native here; the AG-UI `Interrupt` is a projection of it.
 *
 * It must also not import `./agents`, even though an inbox row would read better with
 * `agentKeySchema` on it: `ai/agents.ts` imports THIS file, and a cycle between two modules whose
 * schemas are built at module scope is a top-level TDZ crash at runtime, not a type error.
 */
import { z } from 'zod'
import { paginationQuerySchema } from '../pagination'

/**
 * A JSON Schema object as it travels on the wire. Loose on purpose: it is produced server-side by
 * `toolInputSchema()` (`services/ai/kit.ts`) and consumed by a renderer that falls back to a JSON
 * textarea for anything it does not understand, so validating its internals here would buy nothing
 * and would pin the kit to one JSON Schema draft.
 *
 * It is also what keeps zod off the client: the zod schema stays on the server, the DERIVED JSON
 * Schema is the contract — which is what holds the zod-3/zod-4 boundary.
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown())
export type JsonSchema = z.infer<typeof jsonSchemaSchema>

// ---- Kinds ------------------------------------------------------------------------------------

/** The closed set of questions an agent may ask a person. Append LAST; it is a `z.enum`. */
export const AGENT_INTERRUPT_KINDS = ['approval', 'choice', 'input', 'form'] as const
export const agentInterruptKindSchema = z.enum(AGENT_INTERRUPT_KINDS)
export type AgentInterruptKind = z.infer<typeof agentInterruptKindSchema>

/**
 * How a `cancelled` answer is interpreted, per kind — **the rejection semantics, in one place**.
 *
 * - `approval` → `cancel_run`: a rejection is a human saying stop. The tool is not run and the run
 *   settles `cancelled`.
 * - `choice` / `input` / `form` → `tell_model`: declining to answer is an ANSWER, not a veto. It
 *   goes back to the model as a tool result so the agent can try another route.
 *
 * An app that disagrees edits one line. An `approval` spec may override its own default with
 * `onReject`, which is the per-ask escape hatch.
 */
export const INTERRUPT_REJECTION = {
  approval: 'cancel_run',
  choice: 'tell_model',
  input: 'tell_model',
  form: 'tell_model',
} as const satisfies Record<AgentInterruptKind, 'cancel_run' | 'tell_model'>

export type InterruptRejection = (typeof INTERRUPT_REJECTION)[AgentInterruptKind]

/**
 * The AG-UI `Interrupt.reason` each kind maps to. Derived, never hand-written at a call site:
 * `reason` is a stored column, and two places computing it is two places to disagree.
 *
 * `approval` is `confirmation` in general but `tool_call` when the ask is gating a specific tool
 * call — see {@link aguiReasonFor}, which is the function every writer should use.
 */
export const AGUI_REASON_FOR_KIND = {
  approval: 'confirmation',
  choice: 'input_required',
  input: 'input_required',
  form: 'input_required',
} as const satisfies Record<AgentInterruptKind, string>

/** The stored `reason` for an ask: `tool_call` when an approval gates a named tool call. */
export function aguiReasonFor(kind: AgentInterruptKind, toolCallId?: string | null): string {
  if (kind === 'approval' && toolCallId) return 'tool_call'
  return AGUI_REASON_FOR_KIND[kind]
}

// ---- Form fields ------------------------------------------------------------------------------

/** The closed set of field types a `form` ask may use. One renderer serves all five. */
export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'boolean'] as const
export const formFieldTypeSchema = z.enum(FORM_FIELD_TYPES)
export type FormFieldType = z.infer<typeof formFieldTypeSchema>

export const formFieldOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().max(500).optional(),
})
export type FormFieldOption = z.infer<typeof formFieldOptionSchema>

/** Longest free-text answer any single field accepts unless it narrows it further. */
export const FORM_FIELD_MAX_LENGTH = 10_000

export const formFieldSchema = z.object({
  /** The key this field's answer lands under in `payload.values`. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain identifier'),
  label: z.string().min(1).max(200),
  type: formFieldTypeSchema,
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  /** `select` only — the answer must be one of these values. */
  options: z.array(formFieldOptionSchema).min(1).optional(),
  /** `number` only. */
  min: z.number().optional(),
  /** `number` only. */
  max: z.number().optional(),
  /** `text` / `textarea` only. */
  maxLength: z.number().int().positive().max(FORM_FIELD_MAX_LENGTH).optional(),
})
export type FormField = z.infer<typeof formFieldSchema>

/**
 * The SECOND validation pass for a `form` answer: "required" and "must be one of these options"
 * enforced by the same code the UI validates its draft with, so a client-side pass and the route's
 * 400 cannot disagree about what a valid answer is.
 */
export function formValuesSchemaFor(fields: readonly FormField[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) {
    let value: z.ZodTypeAny
    switch (field.type) {
      case 'text':
      case 'textarea': {
        let text = z.string().max(field.maxLength ?? FORM_FIELD_MAX_LENGTH)
        if (field.required) text = text.trim().min(1)
        value = text
        break
      }
      case 'number': {
        let num = z.number()
        if (field.min !== undefined) num = num.min(field.min)
        if (field.max !== undefined) num = num.max(field.max)
        value = num
        break
      }
      case 'select': {
        const values = (field.options ?? []).map(o => o.value)
        // A `select` with no options can only ever be answered wrongly; say so rather than
        // accepting anything.
        value =
          values.length > 0
            ? z.enum(values as [string, ...string[]])
            : z.never({ invalid_type_error: 'this field has no options to choose from' })
        break
      }
      case 'boolean':
        value = z.boolean()
        break
    }
    shape[field.name] = field.required ? value : value.optional()
  }
  return z.object(shape).strict()
}

// ---- The ask (`spec`) -------------------------------------------------------------------------

/** Longest question text an ask may carry. */
export const INTERRUPT_MESSAGE_MAX_CHARS = 4_000
/** Longest free-text answer an `input` ask accepts unless its spec narrows it. */
export const INTERRUPT_INPUT_MAX_CHARS = 10_000
/** Longest note a person may attach to any answer. */
export const INTERRUPT_NOTE_MAX_CHARS = 2_000

const askBase = {
  /** Short heading for the panel; the question itself is `message`. */
  title: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(INTERRUPT_MESSAGE_MAX_CHARS),
}

/** The tool an `approval` ask is gating, when it gates one. */
export const approvalToolSchema = z.object({
  name: z.string().min(1),
  /** The arguments the model produced, already validated against the tool's own schema. */
  input: z.unknown(),
  /**
   * Whether the approver may change those arguments before approving. Default false, and the
   * route re-validates an edit against `inputSchema`: a client that can edit tool arguments is a
   * client that can call anything.
   */
  allowEdits: z.boolean().default(false),
  /** The tool's JSON Schema — what an edited input is checked against. */
  inputSchema: jsonSchemaSchema.optional(),
})
export type ApprovalTool = z.infer<typeof approvalToolSchema>

export const approvalAskSchema = z.object({
  kind: z.literal('approval'),
  ...askBase,
  tool: approvalToolSchema.optional(),
  /** Overrides {@link INTERRUPT_REJECTION}.approval for this one ask. */
  onReject: z.enum(['cancel_run', 'tell_model']).optional(),
  confirmLabel: z.string().max(60).optional(),
  rejectLabel: z.string().max(60).optional(),
})

export const choiceAskSchema = z.object({
  kind: z.literal('choice'),
  ...askBase,
  options: z.array(formFieldOptionSchema).min(1).max(50),
  /** Allow an answer outside `options` (the UI offers a free-text "something else"). */
  allowOther: z.boolean().default(false),
})

export const inputAskSchema = z.object({
  kind: z.literal('input'),
  ...askBase,
  placeholder: z.string().max(200).optional(),
  multiline: z.boolean().default(false),
  maxLength: z.number().int().positive().max(INTERRUPT_INPUT_MAX_CHARS).optional(),
})

export const formAskSchema = z.object({
  kind: z.literal('form'),
  ...askBase,
  fields: z.array(formFieldSchema).min(1).max(30),
})

/** The typed `spec` jsonb column: what was asked, in the shape the panel needs to draw it. */
export const agentInterruptSpecSchema = z.discriminatedUnion('kind', [
  approvalAskSchema,
  choiceAskSchema,
  inputAskSchema,
  formAskSchema,
])
export type AgentInterruptSpec = z.infer<typeof agentInterruptSpecSchema>

/** What a rejection of this ask does — the ask's own `onReject`, else the kind's default. */
export function rejectionFor(spec: AgentInterruptSpec): InterruptRejection {
  if (spec.kind === 'approval' && spec.onReject) return spec.onReject
  return INTERRUPT_REJECTION[spec.kind]
}

// ---- The answer (`payload`) -------------------------------------------------------------------

const noteField = { note: z.string().max(INTERRUPT_NOTE_MAX_CHARS).optional() }

/**
 * Approving. There is deliberately **no `approved: boolean`** here: whether the answer is an
 * approval or a rejection is carried by `status` (`resolved` / `cancelled`), which is AG-UI's own
 * `ResumeEntry` vocabulary. Two ways to say no is how a UI and a server end up disagreeing.
 */
export const approvalPayloadSchema = z.object({
  ...noteField,
  /** Only valid when the ask's `tool.allowEdits` is true; re-validated against `tool.inputSchema`. */
  editedInput: z.unknown().optional(),
})
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>

export const choicePayloadSchema = z.object({
  ...noteField,
  /** One of the ask's `options[].value`, or free text when the ask set `allowOther`. */
  value: z.string().min(1).max(INTERRUPT_INPUT_MAX_CHARS),
})
export type ChoicePayload = z.infer<typeof choicePayloadSchema>

export const inputPayloadSchema = z.object({
  ...noteField,
  text: z.string().trim().min(1).max(INTERRUPT_INPUT_MAX_CHARS),
})
export type InputPayload = z.infer<typeof inputPayloadSchema>

export const formPayloadSchema = z.object({
  ...noteField,
  values: z.record(z.string(), z.unknown()),
})
export type FormPayload = z.infer<typeof formPayloadSchema>

/** What a `cancelled` answer may carry: the reason, and nothing else. */
export const interruptRejectionPayloadSchema = z.object(noteField)
export type InterruptRejectionPayload = z.infer<typeof interruptRejectionPayloadSchema>

/**
 * The validator for a `resolved` answer to THIS ask — the kind's payload schema, narrowed by what
 * the ask actually offered. It is the one implementation: the route validates the body with it and
 * the UI validates its draft with it, so a 400 is never a surprise.
 *
 * A `cancelled` answer carries {@link interruptRejectionPayloadSchema} instead.
 */
export function interruptPayloadSchema(spec: AgentInterruptSpec): z.ZodTypeAny {
  switch (spec.kind) {
    case 'approval':
      return approvalPayloadSchema.superRefine((value, ctx) => {
        if (value.editedInput !== undefined && !spec.tool?.allowEdits) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['editedInput'],
            message: 'this approval does not allow editing the tool input',
          })
        }
      })
    case 'choice':
      return choicePayloadSchema.superRefine((value, ctx) => {
        if (spec.allowOther) return
        if (!spec.options.some(option => option.value === value.value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: 'must be one of the offered options',
          })
        }
      })
    case 'input':
      return z.object({
        ...noteField,
        text: z
          .string()
          .trim()
          .min(1)
          .max(spec.maxLength ?? INTERRUPT_INPUT_MAX_CHARS),
      })
    case 'form':
      return z.object({ ...noteField, values: formValuesSchemaFor(spec.fields) })
  }
}

// ---- The row ----------------------------------------------------------------------------------

/**
 * `pending` → `resolved` (answered) | `cancelled` (declined) | `expired` (nobody answered in time,
 * or the run settled underneath it). Only `pending` is writable; every settle is a compare-and-set
 * on it, which is what makes "one 200, one 409" true for two people answering at once.
 */
export const AGENT_INTERRUPT_STATUSES = ['pending', 'resolved', 'cancelled', 'expired'] as const
export const agentInterruptStatusSchema = z.enum(AGENT_INTERRUPT_STATUSES)
export type AgentInterruptStatus = z.infer<typeof agentInterruptStatusSchema>

/** Who may answer an agent's asks. `requester` = whoever may cancel the run (the default). */
export const AGENT_APPROVERS = ['requester', 'admin'] as const
export const agentApproversSchema = z.enum(AGENT_APPROVERS)
export type AgentApprovers = z.infer<typeof agentApproversSchema>

/** One row of `agent_run_interrupts` as the API returns it. `id` IS the AG-UI `Interrupt.id`. */
export const agentRunInterruptSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  /**
   * The agent's own idempotency key for this ask, stable across attempts. `UNIQUE (run_id, key)`
   * is what stops a re-entered `execute` asking the same question a second time.
   */
  key: z.string().min(1).max(200),
  kind: agentInterruptKindSchema,
  /** The AG-UI reason — `confirmation`, `tool_call` or `input_required` (see {@link aguiReasonFor}). */
  reason: z.string(),
  message: z.string().nullable(),
  toolCallId: z.string().nullable(),
  /** The JSON Schema an answer's payload must satisfy, for a client that has no kit code. */
  responseSchema: jsonSchemaSchema.nullable(),
  spec: agentInterruptSpecSchema,
  status: agentInterruptStatusSchema,
  /** The answer, once there is one. Shape depends on `kind` — see {@link interruptPayloadSchema}. */
  payload: z.unknown().nullable(),
  expiresAt: z.coerce.date().nullable(),
  resolvedAt: z.coerce.date().nullable(),
  resolvedByUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AgentRunInterrupt = z.infer<typeof agentRunInterruptSchema>

/**
 * `POST /api/agents/runs/:id/interrupts/:interruptId`. `status` is the decision and `payload` is
 * the answer — the same two fields AG-UI's own `ResumeEntry` carries, so a third-party client
 * answering a kit run needs no kit-specific vocabulary.
 */
export const resolveInterruptRequestSchema = z.object({
  status: z.enum(['resolved', 'cancelled']),
  payload: z.unknown().optional(),
})
export type ResolveInterruptRequest = z.infer<typeof resolveInterruptRequestSchema>

// ---- The inbox --------------------------------------------------------------------------------

export const interruptInboxQuerySchema = paginationQuerySchema.extend({
  status: agentInterruptStatusSchema.default('pending'),
})
export type InterruptInboxQuery = z.infer<typeof interruptInboxQuerySchema>

/**
 * Just enough of the run to render an inbox row without a second fetch.
 *
 * `agentKey` is a plain string rather than `agentKeySchema` because `ai/agents.ts` imports this
 * file: narrowing it here would close a module cycle, and two zod modules in a cycle fail at
 * module-evaluation time, not at compile time.
 */
export const interruptRunRefSchema = z.object({
  id: z.string().uuid(),
  agentKey: z.string(),
  status: z.string(),
  requestedByUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
})
export type InterruptRunRef = z.infer<typeof interruptRunRefSchema>

/** `GET /api/agents/interrupts` item — the ask plus the run it belongs to. */
export const interruptInboxItemSchema = agentRunInterruptSchema.extend({
  run: interruptRunRefSchema,
  /** Whether THIS caller may answer it (`approvers` policy). A member under `admin` sees it read-only. */
  canAnswer: z.boolean(),
})
export type InterruptInboxItem = z.infer<typeof interruptInboxItemSchema>

// ---- Steering ---------------------------------------------------------------------------------

/** Longest steering note a person may send to a running agent. */
export const STEERING_MAX_CHARS = 4_000

export const createSteeringNoteRequestSchema = z.object({
  text: z.string().trim().min(1).max(STEERING_MAX_CHARS),
})
export type CreateSteeringNoteRequest = z.infer<typeof createSteeringNoteRequestSchema>

/**
 * The `data` of a `steering` event row. It is an `agent_run_events` row and not a table, because a
 * note is immutable, positional and per-run — exactly what an append-only log is for (decision 4).
 */
export const steeringNoteDataSchema = z.object({
  text: z.string().min(1).max(STEERING_MAX_CHARS),
  authorUserId: z.string().uuid().nullable(),
  authorName: z.string().max(200).optional(),
})
export type SteeringNoteData = z.infer<typeof steeringNoteDataSchema>

/** A note as the runtime hands it to an agent — the event id is the once-only delivery key. */
export const agentSteeringNoteSchema = steeringNoteDataSchema.extend({
  eventId: z.string().uuid(),
  at: z.coerce.date(),
})
export type AgentSteeringNote = z.infer<typeof agentSteeringNoteSchema>

// ---- Event-row payloads -----------------------------------------------------------------------

/**
 * The `data` of an `interrupt` event row: the ask as it was MADE. Thin on purpose — the row in
 * `agent_run_interrupts` is mutable (it gains a status and an answer), the log is not, so the log
 * records the position in the timeline and the table records the state.
 */
export const agentInterruptEventDataSchema = z.object({
  interruptId: z.string().uuid(),
  key: z.string(),
  kind: agentInterruptKindSchema,
  message: z.string().nullable(),
  toolCallId: z.string().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
})
export type AgentInterruptEventData = z.infer<typeof agentInterruptEventDataSchema>

/** The `data` of an `interrupt.resolved` event row. */
export const agentInterruptResolvedEventDataSchema = z.object({
  interruptId: z.string().uuid(),
  key: z.string(),
  kind: agentInterruptKindSchema,
  status: agentInterruptStatusSchema,
  resolvedByUserId: z.string().uuid().nullable(),
})
export type AgentInterruptResolvedEventData = z.infer<typeof agentInterruptResolvedEventDataSchema>
