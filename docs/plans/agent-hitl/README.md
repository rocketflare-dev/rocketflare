# Agent runs: human-in-the-loop, live progress, and a real workspace

Implementation plan for [issue #17](https://github.com/rocketflare-dev/rocketflare/issues/17)
(HITL interrupts + the run page) and [issue #7](https://github.com/rocketflare-dev/rocketflare/issues/7)
(live run streaming), with the run surface rebuilt as a kit-owned workspace.

**This folder is working material, not kit documentation.** It is `neverPort` in
`.rocketflare.json`, so `pnpm kit:upgrade` never pushes it into an adopted copy. When the work
ships, the durable parts move into `docs/CONCEPTS.md` §9, the `.claude/rules/*` files and
`docs/upgrades/`, and this folder is deleted — git history is the archive.

## Status

| Phase | File | State |
|---|---|---|
| 1 · Contracts | [01-contracts.md](01-contracts.md) | **done** |
| 2 · Schema + migration | [02-schema.md](02-schema.md) | **done** |
| 3 · Runtime | [03-runtime.md](03-runtime.md) | **done** |
| 4 · Workflow | [04-workflow.md](04-workflow.md) | **done** |
| 5 · Routes, permissions, projection | [05-routes.md](05-routes.md) | **done** |
| 6 · Live streaming | [06-streaming.md](06-streaming.md) | **done** |
| 7 · The run workspace (UI) | [07-ui.md](07-ui.md) | not started |
| 8 · Examples + docs | [08-examples-docs.md](08-examples-docs.md) | not started |
| — · Verification | [09-verification.md](09-verification.md) | — |

Phases 1 → 5 land in order, each green on its own gate
(`pnpm lint && pnpm typecheck && pnpm test && pnpm build`). Phases 6 and 7 are independent of each
other once 5 lands, and **the UI is built against the poll path first** so it never depends on the
stream — `useRunStream` stays additive, and deleting it must leave a working page.

## Why

The agent layer is durable and correct but **fire-and-forget**. A run is a Workflow instance with
three steps (`claim → execute → finish`); it succeeds, fails, or is cancelled. There is no third
answer — `waitForEvent`, `sleep`, `approval` and `paused` appear nowhere in `services/agents/**`,
`workflows/**` or `ai/kit.ts`. `POST /api/agui/run` still refuses client `tools[]` with 400
`agui_client_tools_unsupported` for exactly this reason.

That ceiling is what stops the kit shipping an agent that does anything consequential. Send this
email? Delete these rows? Which of these three customers did you mean?

The surface has the same ceiling. A run lives in `RunDetailDrawer` — a `max-w-3xl` `<Modal>` over
`AgentsPage` — showing a `<dl>`, one flat `<ol>` rendering tool results as `<pre>`, and an output
panel hard-coding two agent keys. It fills in 3-second poll lumps while the chat page beside it
streams token by token. A modal is the wrong home for something a person is asked to *act* on,
arrives at from a notification, may need to read a document before deciding, and may leave and come
back to.

**Outcome:** an agent can suspend durably mid-run and resume on a human decision; a run is a
first-class page that fills live; and the primitives exist for genuinely interactive agents —
steering a running agent, typed artifacts, multi-field asks.

## The wire format needs no invention

Verified against the installed `@ag-ui/core@0.0.59` `.d.ts`, not the docs:

- `InterruptSchema { id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata?, subagentRunId? }`
- `ResumeEntrySchema { interruptId, status: 'resolved' | 'cancelled', payload?, metadata? }`
- `RunFinishedInterruptOutcomeSchema`, `AgentCapabilitiesSchema.humanInTheLoop`

And `kitAguiEventSchema` already composes `RunFinishedEventSchema` verbatim, while
`kitRunAgentInputSchema` already extends `RunAgentInputSchema`. **The pause and the answer need no
new `kit.` CUSTOM event.** The platform primitives are there too — `worker-configuration.d.ts`
carries `step.waitForEvent` (:13755), `instance.sendEvent` (:15317) and `'waiting'` in
`WorkflowInstanceStatus` (:13760).

## Read before writing code

- **[00-cloudflare-validation.md](00-cloudflare-validation.md)** — is this the Cloudflare pattern?
  (yes for the suspend; a named, defensible divergence on where the loop lives), plus why the
  Agents SDK cannot be adopted here without breaking tenancy.
- **[00-issue-17-corrections.md](00-issue-17-corrections.md)** — **eight bugs in issue #17**, two of
  which strand runs permanently and one of which fails on the first approval in production. Start
  here.
- **[00-decisions.md](00-decisions.md)** — the seven calls everything else follows from.
