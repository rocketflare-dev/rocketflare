---
version: unreleased
previous: 0.39.0
date: null
breaking: false
migrations: []
areas: [api, docs, config]
touches_surfaces: [feature-knowledge]
requires_surfaces: []
manual: false
---

## What changed

Knowledge facts are built and matched only from documents a reader may see, invitations follow their issuer at sign-up, suspended organisations run no queued jobs, and public security reports carry counts only.

- Extraction prompt and decision-model material (known entities, accepted facts, held values) come from tenant-visible documents only, whatever the document being read (`services/knowledge/extract.ts`, `promptScope`).
- `ResolveContext` gains a required `documentVisibility`; a `groups` document adds no aliases to the entity it links to or creates (`services/knowledge/entities.ts`).
- A fact superseded only by a fact the reader cannot see reads as its restored state with `supersededById: null`, and is answerable in `lookup_facts`, counted in `GET /api/knowledge/entities` and reviewable by that reader; `confirm` keeps the stored `superseded` state (`facts-sql.ts` `supersededOutOfViewSql` / `stateInViewSql`, `facts-read.ts`, `review.ts`).
- `findEntitiesByName` and `entitiesMentionedIn` take the reader's `AccessScope` instead of a tenant id and return only staging entities the reader may see, so `lookup_facts` answers an entity known only from hidden documents like an unknown name.
- `hasPendingInvitation` (`services/auth.ts`) counts an open invitation only when `issuerMayIssue` (`services/invitations.ts`, the rule accept already applied) holds for its issuer: not blocked, and a global admin or a member whose role could issue it.
- `setUserBlocked` (`services/admin.ts`) revokes every pending invitation the person issued, in every tenant, in the block's transaction (`revokeEveryInvitationIssuedBy`); unblocking restores none.
- The jobs consumer (`queues/jobs.ts`) reads `tenants.status` for every job whose payload names a tenant and acks it unrun unless the tenant is `active`; `tenant.purge` and `activity.record` always run, plugin jobs follow the same rule.
- A dropped `document.index` / `document.convert` leaves a `pending` document `failed`, so Retry picks it up after reactivation. Rationale: `docs/CONCEPTS.md` §1.
- `public-report`'s entries file is `{ repos, runs[{ date, commit, scope, coverage_units, agent_calls, confirmed: { high, medium, low }, fixed_in: [release] }], fixed[{ release, repo, high, medium, low, hardening }], contact? }`; `critical` is an optional count.
- The `findings` and `hardening` lists and every `line` are gone; `line`, `title`, `description` or any unknown field refuses the whole file, as do a count with no fixing release, a negative or fractional count, or a repo not in `repos`.
- `report.md`/`report.json` carry a fixed sentence: individual issues are not published, "Please request the detailed report by emailing <contact>" (default `security@rocketflare.dev`).
- `SKILL.md` "Public report", `docs/SECURITY-AUDIT.md`, `docs/CONCEPTS.md` (rf-security) and `SECURITY.md` state that only counts are ever published.
- Rationale: `docs/CONCEPTS.md` §9 "Knowledge facts" (extraction and "Reading facts").

## How to apply

1. Port the changes to `apps/web/src/api/services/knowledge/{extract,entities,facts-sql,facts-read,lookup,review}.ts`; the patch applies as-is unless an app edited those files.
2. In any app code that builds a `ResolveContext` for `planMention` / `resolveMention`, add `documentVisibility: 'tenant' | 'groups'` taken from the document the mention was read from.
3. In any app code that calls `findEntitiesByName(db, tenantId, …)` or `entitiesMentionedIn(db, tenantId, …)`, pass the reader's `AccessScope` (`accessScopeOf(auth)`, or `fullAccessScope(tenantId)` for a maintenance path) in place of the tenant id.
4. Copy the tests `apps/web/tests/api/security/knowledge-visibility-producer.test.ts` and `apps/web/tests/api/security/knowledge-visibility-readers.test.ts`.
5. No migration, no data backfill: aliases stored by an earlier release stay on their entities; remove any by hand that a restricted document contributed if that matters to the app.
6. Take `apps/web/src/api/services/invitations.ts`, `apps/web/src/api/services/auth.ts`, `apps/web/src/api/services/admin.ts` and `apps/web/src/api/queues/jobs.ts`.
7. Take `apps/web/tests/api/security/invitation-issuer-admission.test.ts` and `apps/web/tests/api/security/suspended-tenant-jobs.test.ts`.
8. Take the updated `apps/web/tests/api/jobs-consumer.test.ts`, `apps/web/tests/api/plugin-events.test.ts` and the `src/api/services/invitations.ts` reason in `apps/web/tests/config/unscoped-allowlist.test.ts`.
9. If a plugin of yours enqueues a job whose payload carries a `tenantId` and that job must run for a suspended tenant, move that work out of the job: the consumer now drops it until the tenant is reactivated.
10. If one of your own tests consumes a job naming a tenant id that has no `tenants` row, create the tenant first: such a job is now acked without running.
11. Take the kit's `.claude/skills/rf-security/tools/audit.mjs` (the `public-report` section: `PUBLIC_FIELDS`, `publicReportProblems`, `publicReport`) and `apps/web/tests/config/rf-security/public-report.test.ts`.
12. Take the "Public report" section of `.claude/skills/rf-security/SKILL.md` and the "Publishing a report" section of `docs/SECURITY-AUDIT.md`.
13. Set `"contact"` in your entries file to your own security address; without it the report names `security@rocketflare.dev`, the kit's.
14. Rewrite any existing entries file in the new shape: per run, the confirmed counts by severity and the releases that fixed them; one `fixed` entry per repository and release with its counts by severity and its hardening count. Drop every `line`.

## Conflicts to expect

- `apps/web/src/api/services/knowledge/entities.ts` → reader lookups take an `AccessScope` → update any app caller as in How to apply step 3.
- `apps/web/src/api/queues/jobs.ts` → a tenant-status check before dispatch → keep your own handler entries and take the check.
- `apps/web/src/api/services/admin.ts` → `setUserBlocked` now runs in a transaction → keep your additions inside it.
- `SECURITY.md` → its audit paragraph now says only counts are published → keep your own wording and links, but do not promise per-finding publication.

## Verify

1. `pnpm typecheck` passes.
2. `pnpm web test:api` passes, including `tests/api/security/knowledge-visibility-producer.test.ts` and `tests/api/security/knowledge-visibility-readers.test.ts`.
3. `pnpm web test:api` passes, including `tests/api/security/invitation-issuer-admission.test.ts` and `tests/api/security/suspended-tenant-jobs.test.ts`.
4. `pnpm gate` passes.
5. `pnpm web exec vitest run --project config tests/config/rf-security/public-report.test.ts` passes.
6. `node .claude/skills/rf-security/tools/audit.mjs public-report <entries.json>` on a file with a `line` field prints `REFUSED` and `nothing written`, and exits 1.
