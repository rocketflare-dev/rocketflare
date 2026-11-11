---
version: unreleased
previous: 0.33.0
date: null
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Suspended organisations run no agents.

- Suspension: `enqueueRun` / `enqueueRunBatch` refuse a non-active tenant with 403 `tenant_suspended` (route, plugin and event trigger alike); `executeRun` settles a run whose tenant is suspended `cancelled` before any model call; `isCancelRequested` reads the tenant's status, so an executing run stops at its next poll; `setTenantSuspended` cancels the tenant's `queued` and `awaiting_input` runs. See `docs/CONCEPTS.md` §1.

## How to apply

1. Add `assertTenantActive(db, tenantId)` to `apps/web/src/api/services/agents/runs.ts` (403 `ForbiddenError` with `ERROR_CODES.tenantSuspended` unless `tenants.status` is `active`) and call it in `enqueueRun` after input validation and in `enqueueRunBatch` before `assertCapacity`.
2. In `apps/web/src/api/services/agents/runs.ts`, make `isCancelRequested` join `tenants` and also answer `true` when the tenant's status is not `active`.
3. In `executeRun` (`apps/web/src/api/services/agents/runtime.ts`), read the tenant's `name` and `status` first; when the status is not `active`, `cancelRun`, `expireInterrupts`, emit `{ type: 'status', data: { status: 'cancelled', reason: 'tenant_suspended' } }` and return `cancelled` before `checkCancelled()` and `resolveChat`.
4. Change `setTenantSuspended` in `apps/web/src/api/services/admin.ts` to take `(db, { tenantId, suspended, admin, env, logger, realtime })` and, when suspending, call `requestCancel(db, tenantId, runId, realtime, env)` for each `queued` / `awaiting_input` run of the tenant; pass `env: c.env` and `logger` from `POST /api/admin/tenants/:id/suspend` in `routes/admin.ts`.

## Conflicts to expect

- `apps/web/src/api/services/admin.ts` → `setTenantSuspended` takes one input object → update an app's own callers to the new shape.

## Verify

1. `tests/api/security/agent-run-tenant-suspension.test.ts` passes.
2. `tests/api/plugin-events.test.ts` passes, including "agent triggers and a suspended organisation".
