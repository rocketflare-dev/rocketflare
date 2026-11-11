---
version: unreleased
previous: 0.33.0
date: null
breaking: false
migrations:
  - "new table tenant_creation_counters (user_id, day, created), no foreign key to tenants"
areas: [api, db, plugins, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Suspended organisations run no agents, invitation and ownership rules hold on every path, API keys stay in their organisation, AI config saves lock their row, decide's fallback is metered, sign-in mail counts per mailbox, and upload paths keep a body cap.

- Suspension: `enqueueRun` / `enqueueRunBatch` refuse a non-active tenant with 403 `tenant_suspended` (route, plugin and event trigger alike); `executeRun` settles a run whose tenant is suspended `cancelled` before any model call; `isCancelRequested` reads the tenant's status, so an executing run stops at its next poll; `setTenantSuspended` cancels the tenant's `queued` and `awaiting_input` runs. See `docs/CONCEPTS.md` §1.
- Plugin hook: `ServerPlugin.hooks.onTenantStatusChanged(db, tenantId, status, env)` runs for every installed plugin after a suspend or reactivate, best-effort (`runTenantStatusChangedHooks` in `utils/db/tenant-helpers.ts`). See `docs/CONCEPTS.md` §16.
- Invitations: `acceptInvitation` re-checks the issuer inside its transaction (exists, not blocked, a global admin or a member whose role could issue the invitation's role) and otherwise marks the row revoked and answers 410 `invitation_revoked`; `changeMemberRole` revokes the target's pending invitations the new role could not issue. See `docs/CONCEPTS.md` §1.
- Ownership ceiling: `MAX_OWNED_TENANTS_PER_USER` is checked (`assertMayOwnAnother`, under the user-row lock) on a promotion to owner and on accepting an owner invitation, and also bounds creations per person per UTC day through the new `tenant_creation_counters` table, which has no foreign key to `tenants`. See `docs/CONCEPTS.md` §1.
- API keys: a key acts only within its organisation plus its creator's own profile — `GET /api/tenants` lists the key's organisation alone, and `POST /api/tenants`, `GET /api/invitations/pending` and `POST /api/access-requests` answer 403 `insufficient_scope` to a key (`withAccountAuth`). See `docs/CONCEPTS.md` §2.
- AI config saves: `POST /api/ai/config` reads the row it overwrites `FOR UPDATE` inside its transaction and decides whether the stored key stays on that row, so a concurrent save never leaves a key beside an endpoint it was not saved with. See `docs/CONCEPTS.md` §9.
- Decide metering: `ctx.decide`'s chat fallback runs through the run meter like `ctx.chat.client` — `assertPriced` and `check()` before each model call, one `ai_usage` row as each returns (a decide whose answer fails validation twice leaves both), priced on who pays for the `agent-decide` model; `createDecide` records once per ask only for TypeSafe. See `docs/CONCEPTS.md` §9.
- Sign-in mail per recipient: the 5-per-15-minutes window is keyed on the canonical mailbox (`canonicalMailbox`: lower-cased, `+tag` dropped, dots dropped for `gmail.com` / `googlemail.com`), so tagged and dotted spellings of one mailbox share it; mail still goes to the address as typed. See `docs/CONCEPTS.md` §2.
- Upload-path body cap: beneath `UPLOAD_PATHS` and a plugin's `uploadPaths`, a JSON body keeps the 1 MB cap and any other body is capped at `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB) instead of skipping the cap; each upload route's own tighter cap still applies. See `docs/CONCEPTS.md` §3.

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
10. Add `apps/web/src/db/schema/tenant-creation-counters.ts` (`tenant_creation_counters`: `user_id` uuid → `users` on delete cascade, `day` date default `(now() at time zone 'utc')::date`, `created` integer default 0, primary key `(user_id, day)`, NO foreign key to `tenants`), export it from `apps/web/src/db/schema/index.ts`, add `'tenant_creation_counters'` to `RLS_EXCLUDED_TABLES` in `apps/web/src/db/schema/rls.ts`, then run `pnpm db:generate` and `pnpm db:migrate`.
11. In `apps/web/src/api/utils/db/tenant-helpers.ts`, add `assertMayOwnAnother(tx, userId, max)` (lock the user row `FOR UPDATE`, exempt a global admin, 403 `tenant_limit_reached` at `max` owner rows), call it from `createTenantForUser` in place of the inline count, add a `chargeTenantCreation` upsert on `tenant_creation_counters` (conditional update `created < max`, no row back → the same 403) in the same transaction, and add `pruneTenantCreationCounters(db)` to `runPruneExpired` in `apps/web/src/api/scheduled.ts`.
12. Add `maxOwnedTenants?: number` to `changeMemberRole` (`services/members.ts`, checked inside its transaction when the new role is `owner`) and to `acceptInvitation` (`services/invitations.ts`, checked inside its transaction when the person would become an owner), and pass `maxOwnedTenants: cfg.MAX_OWNED_TENANTS_PER_USER` from `PATCH /api/members/:userId` (`routes/members.ts`) and `POST /api/invite/:token/accept` (`routes/invite.ts`).
13. Add `'src/api/utils/db/tenant-helpers.ts'` to `CORE_UNSCOPED_ALLOWLIST` in `apps/web/tests/config/unscoped-allowlist.test.ts`: `assertMayOwnAnother` counts one person's owner rows across every tenant.
14. Add `withAccountAuth(c)` beside `withAuth` in `apps/web/src/api/utils/routes/route-helpers.ts`: it calls `withAuth(c)` and throws `ForbiddenError(…, ERROR_CODES.insufficientScope)` when `isApiKeySession(ctx.auth)` (from `middleware/auth.ts`).
15. Use `withAccountAuth` in place of `withAuth` in `POST /api/tenants` (`routes/tenants.ts`, then drop its `isApiKeySession` guard around `updateSelectedTenant`), `GET /api/invitations/pending` (`routes/invitations.ts`) and `POST /api/access-requests` (`routes/access-requests.ts`); in `GET /api/tenants`, return only the summary whose `id` is `auth.tenantId` when `isApiKeySession(auth)`. Give any tenant-free route of an app's own that reads or changes the person's other organisations the same treatment.
16. In `POST /api/ai/config` (`apps/web/src/api/routes/ai-config.ts`), move the read of the existing `(tenant, scope, label)` row inside the transaction as `tx.select().from(aiConfigs).where(…).for('update')`; when there is none, run `validateUpsert(body, undefined)` and `insert … onConflictDoNothing({ target: [tenantId, scope, label] }).returning()`, and when that returns no row (a concurrent first save) read the row `FOR UPDATE` again; for an existing row run `validateUpsert(body, existing)` and `update … where id` with `apiKeyEnc` set to the new key, left alone when `keepsStoredKey(existing, body)`, else `null`.
17. Nothing to do in the driver seam for `FOR UPDATE`: `tests/driver/driver.test.ts` gains a case proving a row lock taken in `db.transaction` holds under both drivers.
18. In `apps/web/src/api/services/agents/budget.ts`, give `RunMeter.assertPriced` a third optional `billedToPlatform` argument (default: the meter's own) and `meterChatClient` a third `options: { feature?: string; billedToPlatform?: boolean }` argument, passing `billedToPlatform` to `assertPriced` and `feature` to every `meter.record` call.
19. In `resolveDecisions` (`apps/web/src/api/services/ai/resolve.ts`), change `wrapChat` to `(client, chat: { provider, billedToPlatform }) => ChatClient` and call it with the `agent-decide` chat resolution's `provider` and `billedToPlatform`.
20. In `executeRun` (`apps/web/src/api/services/agents/runtime.ts`), make the `wrapChat` passed to `resolveDecisions` return `meterChatClient(traceChatClient(…), meter, { feature, billedToPlatform: chat.billedToPlatform })` with `feature` = `agent:<agent key>:decide`.
21. In `createDecide` (`apps/web/src/api/services/agents/decisions.ts`), skip the `deps.meter.record(…)` after the ask when `method === 'llm_self_report'`, so a fallback call is not counted twice.
22. An app's own code that calls `resolveDecisions` with `wrapChat` reads the second argument as an object now, not a provider.
23. Add `apps/web/src/api/utils/core/mailbox.ts` exporting `canonicalMailbox(email)` (trim and lower-case; drop everything from the first `+` in the local part unless the local part starts with it; for `gmail.com` or `googlemail.com` remove the local part's dots and write the domain as `gmail.com`), and in `recipientMailAllowed` (`apps/web/src/api/routes/auth/magic-link.ts`) hash `canonicalMailbox(email)` in place of `email.toLowerCase()`.
24. In `apps/web/src/api/middleware/body-limit.ts`, move `MAX_PUBLIC_MOUNT_BODY_BYTES` above the limiters, add `MAX_UPLOAD_PATH_BODY_BYTES = Math.max(MAX_UPLOAD_BYTES, MAX_PUBLIC_MOUNT_BODY_BYTES) + MULTIPART_OVERHEAD_BYTES` with a `bodyLimit` at that size, and in `apiBodyLimit` replace the bare `return next()` for an upload path with `jsonBodyLimit` when the `Content-Type` is `application/json` or `application/*+json`, else the new upload-path limit.
25. Check every upload route of an app's own under `UPLOAD_PATHS` or a plugin's `uploadPaths`: one taking a file larger than 10 MB now needs a larger `MAX_UPLOAD_PATH_BODY_BYTES`, and one reading a JSON body over 1 MB needs a path outside the upload prefix.
26. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs` (the `ServerPlugin.uploadPaths` doc comment changed).

## Conflicts to expect

- `apps/web/src/api/services/admin.ts` → `setTenantSuspended` takes one input object → update an app's own callers to the new shape.
- `apps/web/src/api/services/ai/resolve.ts` → `wrapChat`'s second argument is `{ provider, billedToPlatform }` → update an app's own `wrapChat` callbacks.

## Verify

1. `tests/api/security/agent-run-tenant-suspension.test.ts` passes.
2. `tests/api/plugin-events.test.ts` passes, including "agent triggers and a suspended organisation".
3. `tests/api/plugin-tenant-status-hook.test.ts` passes.
4. `tests/api/security/invitation-authority.test.ts` passes, including "an invitation carries only the authority its issuer still holds".
5. `tests/api/security/tenant-creation.test.ts` passes, including "the ceiling holds wherever ownership is gained".
6. `pnpm db:migrate` applies `0026_kit-tenant-creation-counters.sql`.
7. `tests/api/security/api-key-account-scope.test.ts` passes.
8. `tests/api/security/ai-config-concurrent-saves.test.ts` passes.
9. `tests/api/security/agent-run-budget-accounting.test.ts` passes, including "ctx.decide's chat fallback under the run meter".
10. `tests/api/security/sign-in-mail-per-recipient.test.ts` passes, including "one mailbox under many +tag spellings shares one window".
11. `tests/api/security/upload-path-body-limit.test.ts` passes.
