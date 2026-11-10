---
version: unreleased
previous: 0.32.2
date: null
breaking: false
migrations:
  - "agent_runs gains input_from_requester, a boolean NOT NULL DEFAULT false"
areas: [ci, db, api, ui, shared]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Plugin tools get `ToolCtx.requesterUrls`, the URLs a person typed themselves, and the UI offers "Create organisation" only when the server would allow it.

- `GET /auth/session` answers `canCreateTenant`: false in single mode, under IdP-managed tenancy, and while the person's access request is pending or rejected. `tenantCreationRefusal(cfg, auth)` in `services/tenants.ts` is the one rule `POST /api/tenants` and the session both read.
- `ToolCtx.requesterUrls` (`services/agents/tools/requester-urls.ts`): in chat, URLs from the person's own turns; in an agent run, from the input when a person submitted it through `POST /api/agents/runs` or `/runs/batch`. Empty for runs a plugin or an event started and for `streamChat`.
- `agent_runs.input_from_requester` records which runs those are; `enqueueRun` / `enqueueRunBatch` take `inputFromRequester`, which only the two routes set.
- `@testkit/unit` `makeToolCtx({ requesterUrls })` builds the set for a plugin's tests.
- `OrgSwitcher` and `/select-tenant` hide "Create organisation" when `canCreateTenant` is false, including the `?create=1` deep link; `useAuth()` exposes `canCreateTenant`.
- `.github/workflows/plugin-ci.yml`: the gate step runs `git rm -r -q --ignore-unmatch apps/web/tests/kit-only` first, as the rename does for every copy.
- `apps/web/tests/kit-only/plugin-ci.test.ts` pins that step.

## How to apply

1. Add `canCreateTenant: z.boolean()` to `sessionResponseSchema` in `packages/shared/src/auth.ts`.
2. Add `tenantCreationRefusal(cfg, auth)` to `apps/web/src/api/services/tenants.ts` (the IdP-managed 409 `idp_managed` and the pending/rejected 403 `pending_approval`, moved out of `routes/tenants.ts`), call it from `POST /api/tenants`, and set `canCreateTenant: cfg.TENANCY_MODE === 'multi' && tenantCreationRefusal(cfg, auth) === null` in `buildSessionResponse` (`services/auth.ts`).
3. Expose `canCreateTenant` from `useAuth()` (`session?.canCreateTenant ?? false`), and gate the "Create organisation" link in `OrgSwitcher.tsx` and the button, empty-state text and `?create=1` form in `pages/SelectTenant.tsx` on it.
4. Add `canCreateTenant: true` to `makeSession()` in `apps/web/tests/ui/helpers/renderWithProviders.tsx`, and to any session object an app's own tests build by hand.
5. Add `apps/web/src/api/services/agents/tools/requester-urls.ts`, the optional `requesterUrls` on `AgentToolContext` (`tools/search-knowledge.ts`), and `requesterUrls: ctx.requesterUrls ?? noRequesterUrls()` in `toolCtx()` (`plugins/api/ai.ts`) with the `ToolCtx.requesterUrls` member.
6. Pass `requesterUrls` to `buildAgentTools` in `services/ai/chat-turn.ts` (`requesterUrlsFromTexts` over the window's `user` messages plus the new turn), `services/agents/runtime.ts` and `services/agents/replay.ts` (`requesterUrlsForRun(run, input)`).
7. Add `inputFromRequester: boolean('input_from_requester').notNull().default(false)` to `agent_runs`, run `pnpm db:generate` and `pnpm db:migrate`; add `inputFromRequester` to `EnqueueRunInput` and `EnqueueBatchInput` in `services/agents/runs.ts`, written only when `userId` is set, and pass `inputFromRequester: true` from `POST /api/agents/runs` and `/runs/batch` in `routes/agents.ts`. An app route of its own that enqueues a person's typed input passes it too.
8. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.
9. Nothing to port for the plugin CI change: `plugin-ci.yml` is called from plugin repositories at `@main`, and a copy has no `apps/web/tests/kit-only/`.

## Conflicts to expect

- `apps/web/src/ui/pages/SelectTenant.tsx` → the create button is wrapped in `canCreateTenant` → keep an app's own layout and wrap its create control the same way.
- `apps/web/src/api/routes/tenants.ts` → the two refusals moved into `tenantCreationRefusal` → keep any app-specific check after the call.

## Verify

1. `pnpm web test:ui -- org-switcher select-tenant` passes.
2. `tests/api/security/requester-urls.test.ts` and `tests/config/requester-urls.test.ts` pass.
3. `tests/api/security/tenant-creation.test.ts` passes, including "the session says whether creating an organisation is allowed".
4. A plugin repository's CI run shows no `kit-only` project in the kit's gate.
