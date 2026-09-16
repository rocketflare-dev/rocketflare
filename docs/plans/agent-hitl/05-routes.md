# Phase 5 — Routes, permissions, notification, projection

**Goal:** answer an interrupt, find what is waiting, and read a parked run back as spec AG-UI.

## Routes on `/api/agents`

| Route | Guard | Behaviour |
|---|---|---|
| `POST /runs/:id/interrupts/:interruptId` | `update AgentRun` + approver policy | the eight steps below |
| `GET /interrupts?status=pending` | `read AgentRun` | the inbox — joined to `agent_runs`, own runs for a member, all for admin+, paginated on `(tenant_id, status, created_at desc)` |
| `POST /runs/:id/steering` | same as cancel | `appendEventAtomic` + nudge; 409 on a settled run. Allowed while `queued` (it lands before turn one) and while `awaiting_input` (a note plus an answer is a normal pair) |
| `GET /runs/:id` · `/agui` | unchanged | now carry `interrupts[]` and `artifacts[]` |
| `GET /runs/:id?events=0` | unchanged | the bare row — see [phase 6](06-streaming.md) |

`POST /api/agents/runs` is untouched: **routes still enqueue, never run.** Resolving an interrupt is
a row write plus a nudge to a Workflow — it does not execute an agent.

## The resolve handler, in order

Each step is a precondition for the next.

1. `getRun` + `visible(auth, run)` → **404** (another tenant's or another member's run never exists)
2. `canAnswer(auth, run, approvers)` → **403**
3. load the interrupt by `(id, tenantId, runId)` → **404**
4. validate `payload` against `interruptPayloadSchema(row.spec)` → **400** with `details`.
   For an `approval` carrying `editedInput`: **reject unless `spec.tool.allowEdits`, then
   re-validate against the tool's stored schema** — *a client that can edit tool args is a client
   that can call anything*
5. `resolveInterrupt` compare-and-set → null means **409 `interrupt_not_pending`**
   (one 200, one 409, one side effect)
6. `appendEventAtomic('interrupt.resolved')`
7. **if no pending interrupts remain** → `resumeRun` then `nudgeOrRestartInstance`. A turn with
   three gated calls parks once and needs all three answers, so do not resume early
8. `recordActivity`, `nudgeRun`, 200

## Permissions

**No new CASL action** (`ACTIONS` is closed) and **no new subject**. `canAnswer` is
`manage/update AgentRun` **plus** `AgentMeta.approvers`:

- `'requester'` (default) = "whoever may cancel this run may answer it" — which is exactly the rule
  `visible()` (`routes/agents.ts:41`) already implements, so there is one mental model, not two.
- `'admin'` is the opt-in for agents that touch money, customers or deletion.

An app wanting approvals gated on their own axis adds their **own** subject; `CORE_SUBJECTS` is
documented as extensible. A member under `approvers: 'admin'` sees their own run's interrupt in the
inbox but gets a 403 on answering — correct, and the UI renders it read-only.

## Notification on park

Inside the `execute` step and **awaited** — there is no `waitUntil` in a Workflow step.

- `notifyMany` (one code path even for one recipient) to the requester, or to the tenant's admins
  when `approvers: 'admin'`.
- **A system-triggered run (`requestedByUserId === null`) falls back to admins** — a parked run
  nobody is told about is a hung agent.
- Guarded by `claimEffect('notify:' + interruptId)` so a re-entered `execute` cannot re-notify.
- Nudge is the existing `entity.changed { entity: 'agent-run' }`; the query-key root is already
  `['agent-run']`, so **no new UI socket code**. Add `entity: 'agent-interrupt'` for the inbox badge.

## Projection (`agui-projection.ts`, still pure)

Signature widens to take `{ interrupts, artifacts }` — it stays a pure function of rows, it just
needs the rows.

| In | Out |
|---|---|
| always, after `RUN_STARTED` | `STATE_SNAPSHOT { …, capabilities: { humanInTheLoop: { supported: true, approvals: true, interrupts: true, interventions: true, feedback: false, approveWithEdits: true } } }` |
| run `awaiting_input` **with** pending rows | `RUN_FINISHED { outcome: { type: 'interrupt', interrupts } }` — the spec's own delivery, so a third-party client answers a kit run with **zero kit-specific code** |
| run `awaiting_input` with **no** pending rows | no terminal event (treated as active). Not "unreachable" (T6) — it is the window between the resolve write and `resumeRun` |
| `interrupt` row | `CUSTOM kit.agent.interrupt` |
| `interrupt.resolved` / `steering` / `artifact` rows | `CUSTOM kit.agent.{interrupt.resolved,steering,artifact}` |

> `kit.agent.interrupt` is **the one addition to #17's "no new CUSTOM event"**, and it is not the
> ask: `outcome` can only carry the *currently pending* set, so a settled run's *historical* asks
> have nowhere else to live and the timeline would silently lose them.

`POST /api/agui/run`'s snapshot gets `humanInTheLoop: { supported: false }` until chat HITL lands.
**Lying here is how a client renders an approve button that does nothing.**

## Done when

- [ ] 409 on a double answer; 403 for another member under `approvers: 'admin'`
- [ ] another tenant's interrupt is a 404
- [ ] `editedInput` without `allowEdits` is a 400
- [ ] a parked run can be cancelled and its interrupts expire
- [ ] **a second enqueue while parked deduplicates** (the widened index)
- [ ] steering on a settled run is a 409
