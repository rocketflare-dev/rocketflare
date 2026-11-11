---
version: unreleased
previous: 0.33.0
date: null
breaking: false
migrations: []
areas: [api, plugins, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Suspended organisations run no agents, plugins hear about a suspension through `hooks.onTenantStatusChanged`, and an invitation is accepted only while its issuer could still issue it.

- Suspension: `enqueueRun` / `enqueueRunBatch` refuse a non-active tenant with 403 `tenant_suspended` (route, plugin and event trigger alike); `executeRun` settles a run whose tenant is suspended `cancelled` before any model call; `isCancelRequested` reads the tenant's status, so an executing run stops at its next poll; `setTenantSuspended` cancels the tenant's `queued` and `awaiting_input` runs. See `docs/CONCEPTS.md` §1.
- Plugin hook: `ServerPlugin.hooks.onTenantStatusChanged(db, tenantId, status, env)` runs for every installed plugin after a suspend or reactivate, best-effort (`runTenantStatusChangedHooks` in `utils/db/tenant-helpers.ts`). See `docs/CONCEPTS.md` §16.
- Invitations: `acceptInvitation` re-checks the issuer inside its transaction (exists, not blocked, a global admin or a member whose role could issue the invitation's role) and otherwise marks the row revoked and answers 410 `invitation_revoked`; `changeMemberRole` revokes the target's pending invitations the new role could not issue. See `docs/CONCEPTS.md` §1.

## How to apply

1. Add `assertTenantActive(db, tenantId)` to `apps/web/src/api/services/agents/runs.ts` (403 `ForbiddenError` with `ERROR_CODES.tenantSuspended` unless `tenants.status` is `active`) and call it in `enqueueRun` after input validation and in `enqueueRunBatch` before `assertCapacity`.
2. In `apps/web/src/api/services/agents/runs.ts`, make `isCancelRequested` join `tenants` and also answer `true` when the tenant's status is not `active`.
3. In `executeRun` (`apps/web/src/api/services/agents/runtime.ts`), read the tenant's `name` and `status` first; when the status is not `active`, `cancelRun`, `expireInterrupts`, emit `{ type: 'status', data: { status: 'cancelled', reason: 'tenant_suspended' } }` and return `cancelled` before `checkCancelled()` and `resolveChat`.
4. Change `setTenantSuspended` in `apps/web/src/api/services/admin.ts` to take `(db, { tenantId, suspended, admin, env, logger, realtime })` and, when suspending, call `requestCancel(db, tenantId, runId, realtime, env)` for each `queued` / `awaiting_input` run of the tenant; pass `env: c.env` and `logger` from `POST /api/admin/tenants/:id/suspend` in `routes/admin.ts`.
5. Add the optional `onTenantStatusChanged?: (db, tenantId, status: 'active' | 'suspended', env: AppBindings) => Promise<void>` to `ServerPlugin.hooks` in `apps/web/src/plugins/types.ts`, add `runTenantStatusChangedHooks(db, tenantId, status, env, logger?, plugins = serverPlugins)` to `apps/web/src/api/utils/db/tenant-helpers.ts` (each hook in its own try/catch, a failure logged with `logger.warn`), and call it last in `setTenantSuspended` with `row.status`.
6. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.
7. In `apps/web/src/api/services/invitations.ts`, add `roleMayIssue(issuerRole, role)` (`owner` needs `owner`; `admin` / `member` need `owner` or `admin`) and `rolesNotIssuableBy(role)`, and give `revokeInvitationsIssuedBy` an optional `roles` filter (`inArray(teamInvitations.role, roles)`; an empty list revokes nothing).
8. In `acceptInvitation`, first thing inside the transaction, select the issuer (`users` left-joined to its `tenant_users` row in `inv.tenantId`); unless it exists, `blockedAt` is null and it is a global admin or `roleMayIssue(role, inv.role)`, set `revokedAt` on the invitation and return `null` from the transaction, then after the transaction nudge `invitation.changed` and throw `ApiError(410, …, 'invitation_revoked')`.
9. In `changeMemberRole` (`apps/web/src/api/services/members.ts`), run the role update and `revokeInvitationsIssuedBy(tx, { tenantId, userId: targetUserId, roles: rolesNotIssuableBy(newRole) })` in one transaction, and nudge `invitation.changed` when anything was revoked.

## Conflicts to expect

- `apps/web/src/api/services/admin.ts` → `setTenantSuspended` takes one input object → update an app's own callers to the new shape.

## Verify

1. `tests/api/security/agent-run-tenant-suspension.test.ts` passes.
2. `tests/api/plugin-events.test.ts` passes, including "agent triggers and a suspended organisation".
3. `tests/api/plugin-tenant-status-hook.test.ts` passes.
4. `tests/api/security/invitation-authority.test.ts` passes, including "an invitation carries only the authority its issuer still holds".
