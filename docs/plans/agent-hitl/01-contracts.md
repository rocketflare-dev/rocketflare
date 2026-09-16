# Phase 1 — Contracts

**Goal:** every schema the later phases need, appends only, nothing renamed. Green on its own gate.

**Do this first, before anything else in phase 1:** write the `agui-contract.test.ts` case that
round-trips `RUN_FINISHED` with an interrupt outcome over **SSE and protobuf**. See
[09-verification.md](09-verification.md) — if protobuf cannot carry it there is no cheap mitigation
and the shape of phases 5–6 changes.

## `packages/shared/src/ai/agents.ts`

- `'awaiting_input'` appended to `agentRunStatusSchema` (append **last** — it is a `z.enum`).
- Export `ACTIVE_RUN_STATUSES` and `CLAIMABLE_RUN_STATUSES`; `isRunActive` reads the first.
- `AGENT_RUN_EVENT_TYPES` gains `'interrupt' | 'interrupt.resolved' | 'steering' | 'artifact'` —
  append-only, and the column is `text().$type<>()`, so **no migration for the values**.
- **`AGENT_RESUME_EVENT = 'agent-resume'`** — *not* `'agent.resume'` (T8).
- `AgentMeta` / `agentInfoSchema` gain `approvers?: 'requester' | 'admin'` and `inputJsonSchema`
  (produced server-side by the existing `toolInputSchema()` in `kit.ts:98`, so no zod crosses the
  wire and the zod-3/zod-4 boundary from #16 holds).
- `agentRunWithEventsSchema` gains `interrupts[]` and `artifacts[]`.
- The `RUN_STREAM_*` constants from [phase 6](06-streaming.md).
- **While here:** promote the existing *conventional* event payload shapes (`tool.*`, `text`,
  `status`, `error`) into real schemas. The UI parses them today with local lenient copies
  (`AgentSteps.tsx:23-53`), which is a second source of truth waiting to drift.

## New `packages/shared/src/ai/interrupts.ts`

A separate file because `agents.ts` is already the run lifecycle plus two examples' schemas, and
this vocabulary is consumed by a route, a service, a projection and later the chat host.

> **It must not import `@ag-ui/core`.** `shared-imports.test.ts` allows that in `ai/agui.ts`
> **alone**. The kit's row shape is zod-native here; `toAguiInterrupt` lives in `agui.ts`.

| Export | Notes |
|---|---|
| `AGENT_INTERRUPT_KINDS = ['approval','choice','input','form']` | the closed set |
| `AGUI_REASON_FOR_KIND` | `approval → 'confirmation'` (or `'tool_call'` when `toolCallId` is set), the rest `'input_required'` — derived, never hand-written |
| `INTERRUPT_REJECTION` | **the rejection semantics, in one place**: `approval → 'cancel_run'` (a rejection is a human saying stop), `choice`/`input`/`form` → `'tell_model'` (an answer, not a veto — it goes back as a tool result so the agent can try another route). One `satisfies Record<Kind, …>`, so an app that disagrees edits one line |
| `FORM_FIELD_TYPES` / `formFieldSchema` | `text · textarea · number · select · boolean`, with `required`, `options`, min/max/maxLength |
| `approval/choice/input/formPayloadSchema` | one per kind |
| `formValuesSchemaFor(fields)` | second pass for `form`, so "required" and "must be one of these options" are enforced by the same code the UI validates with |
| `interruptPayloadSchema(spec)` | the validator. The zod schema stays server-side; the **derived JSON Schema** goes on the wire as the contract |
| `agentInterruptSpecSchema` | discriminated on `kind`; `approval` carries optional `tool { name, input, allowEdits, inputSchema }` and `onReject` |
| `agentRunInterruptSchema` | the API row, including the **mandatory `key`** (T2) |
| `resolveInterruptRequestSchema`, `interruptInboxQuerySchema`, `interruptInboxItemSchema` | |
| `createSteeringNoteRequestSchema`, `steeringNoteDataSchema`, `STEERING_MAX_CHARS` | |

The metadata column is named **`spec` and typed**, not `metadata` and `unknown` — an untyped jsonb
blob called `metadata` is where render bugs live.

## New `packages/shared/src/ai/artifacts.ts`

`AGENT_ARTIFACT_KINDS = ['document','file','markdown','table','json']`, `agentArtifactDataSchema`
(discriminated; `document`/`file` carry **ids, never content**), `agentArtifactSchema` with a `key`
that is the upsert key. Size caps live in the contract, not the table: an artifact bigger than that
belongs in R2 as a `file` artifact.

## `packages/shared/src/errors.ts`

`interrupt_not_pending` (409), `run_not_awaiting_input` (409). Answering without the approver policy
is the existing 403 `forbidden`, deliberately **not** a 404: the run is already readable by that
member, so hiding the interrupt would be theatre.

## `packages/shared/src/ai/agui.ts`

`KIT_CUSTOM_EVENTS` gains `kit.agent.interrupt`, `kit.agent.interrupt.resolved`,
`kit.agent.steering`, `kit.agent.artifact`, plus payload schemas in `kitCustomPayloadSchema` and the
`toAguiInterrupt(row) → Interrupt` mapper. `kitAguiEventSchema` needs **no change**:
`RunFinishedEventSchema` already validates `outcome` and `CustomEventSchema` covers the rest.

## Done when

- [ ] `agui-contract.test.ts` proves the interrupt outcome round-trips over SSE and protobuf
- [ ] a pure test asserts `AGENT_RESUME_EVENT` matches `/^[A-Za-z0-9_-]{1,100}$/` (T8)
- [ ] pure tests for the four payload schemas and `INTERRUPT_REJECTION`
- [ ] `shared-imports.test.ts` still green (no `@ag-ui/core` outside `agui.ts`)
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
