---
version: unreleased
previous: 0.39.0
date: null
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

An invitation now admits a sign-up only while its issuer could still issue it, blocking a person revokes their pending invitations, and a suspended organisation's queued jobs are acknowledged without running.

- `hasPendingInvitation` (`services/auth.ts`) counts an open invitation only when `issuerMayIssue` (`services/invitations.ts`, the rule accept already applied) holds for its issuer: not blocked, and a global admin or a member whose role could issue it.
- `setUserBlocked` (`services/admin.ts`) revokes every pending invitation the person issued, in every tenant, in the block's transaction (`revokeEveryInvitationIssuedBy`); unblocking restores none.
- The jobs consumer (`queues/jobs.ts`) reads `tenants.status` for every job whose payload names a tenant and acks it unrun unless the tenant is `active`; `tenant.purge` and `activity.record` always run, plugin jobs follow the same rule.
- A dropped `document.index` / `document.convert` leaves a `pending` document `failed`, so Retry picks it up after reactivation. Rationale: `docs/CONCEPTS.md` §1.

## How to apply

1. Take `apps/web/src/api/services/invitations.ts`, `apps/web/src/api/services/auth.ts`, `apps/web/src/api/services/admin.ts` and `apps/web/src/api/queues/jobs.ts`.
2. Take `apps/web/tests/api/security/invitation-issuer-admission.test.ts` and `apps/web/tests/api/security/suspended-tenant-jobs.test.ts`.
3. Take the updated `apps/web/tests/api/jobs-consumer.test.ts`, `apps/web/tests/api/plugin-events.test.ts` and the `src/api/services/invitations.ts` reason in `apps/web/tests/config/unscoped-allowlist.test.ts`.
4. If a plugin of yours enqueues a job whose payload carries a `tenantId` and that job must run for a suspended tenant, move that work out of the job: the consumer now drops it until the tenant is reactivated.
5. If one of your own tests consumes a job naming a tenant id that has no `tenants` row, create the tenant first: such a job is now acked without running.

## Conflicts to expect

- `apps/web/src/api/queues/jobs.ts` → a tenant-status check before dispatch → keep your own handler entries and take the check.
- `apps/web/src/api/services/admin.ts` → `setUserBlocked` now runs in a transaction → keep your additions inside it.

## Verify

1. `pnpm web test:api` passes, including `tests/api/security/invitation-issuer-admission.test.ts` and `tests/api/security/suspended-tenant-jobs.test.ts`.
2. `pnpm gate` passes.
