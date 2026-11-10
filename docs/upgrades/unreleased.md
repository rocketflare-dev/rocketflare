---
version: unreleased
previous: 0.31.0
date: null
breaking: false
migrations:
  - "a tenant-scoped plugin_events table (partial unique index on tenant_id, name, idempotency_key), and nullable trigger_event / trigger_event_id columns on agent_runs"
areas: [api, ui, config, scripts, docs, db]
touches_surfaces: [feature-agents]
requires_surfaces: []
manual: false
---

## What changed

Plugins can declare and emit tenant-scoped events that queue one delivery per subscriber, and agents can be triggered by an event or offered as bindable to it.

- `SharedPlugin.events` maps `<id>.<name>` event names (never `kit.`) to zod payload schemas, and `plugin.json` lists them in `"events"`. `tests/config/plugins.test.ts` and `pnpm plugin check` refuse a mis-prefixed, colliding or undeclared name. `EventNameOf`, `EventPayloadOf`, `EVENT_NAME_RE` and `eventNameProblem` come from `@rocketflare/shared/plugins`.
- `ctx.emit(name, { payload, idempotencyKey? })` on `RequestCtx`, `AgentCtx` and the new `EventCtx` (tenant-bound), and `ctx.emit(name, { tenantId, payload, idempotencyKey? })` on `JobCtx`, `CronCtx`, `PublicCtx` and `EmailCtx`, validate the payload (400 `validation_failed`, 400 `event_unknown`), record one `plugin_events` row deduplicated per (tenant, name, key), and queue one `event.deliver` job per subscriber carrying ids only.
- `plugin_events` rows are pruned nightly after `EVENTS_RETENTION_DAYS` (default 7) by the `pruneEvents` task on `0 4 * * *`, and cascade with the tenant.
- `ServerPlugin.eventHandlers: [{ event, name, handle(event, ctx) }]` subscribe a plugin; `eventCtx(ctx)` adapts the context. `APP_EVENT_HANDLERS` in `apps/web/src/api/services/events/app-handlers.ts` subscribes the app's own code. A throw retries that subscriber alone; a 4xx `ApiError` is logged and acknowledged.
- `AgentDefinition.triggers: [eventTrigger(event, { where?, input })]` starts a run per matching event through `enqueueRun`, once per (event, agent). `agent_runs` gains `trigger_event` and `trigger_event_id`, `agentRunSchema` gains `triggerEvent` and `triggerEventId`, and the runs and run pages show the event.
- `AgentDefinition.bindable: [eventBinding(event, { input })]` offers an agent to a picker: `GET /api/agents/bindable?event=` and `listBindableAgents(event)` list it, and `EventCtx.startBoundAgent(agentKey)` starts it for the delivered event, refusing any agent that does not opt in with 403 `agent_not_bindable`.
- `@testkit/integration` exports `deliverEvents(env, db)`, which runs the queued deliveries through the real jobs consumer.
- `example-feature` emits `example-feature.note.created` from `POST /notes`, audits it in `events/note-created.ts` and ships the triggered, bindable `example-feature.note-stats` agent. Design: `docs/CONCEPTS.md` §16 "Plugin events (D42)".

## How to apply

1. Add `events`, `EVENT_NAME_RE`, `eventNameProblem`, `EventsOf`, `EventNameOf` and `EventPayloadOf` to `packages/shared/src/plugins/types.ts` and export them from `packages/shared/src/plugins/index.ts` and `api.ts`. Add `eventDeliverPayloadSchema` and the `event.deliver` variant to `packages/shared/src/jobs.ts`, `eventUnknown` and `agentNotBindable` to `packages/shared/src/errors.ts`, and `triggerEvent`, `triggerEventId` and the bindable-agent schemas to `packages/shared/src/ai/agents.ts`.
2. Add `apps/web/src/db/schema/plugin-events.ts`, export it from `apps/web/src/db/schema/index.ts`, and add `triggerEvent` and `triggerEventId` to `apps/web/src/db/schema/agent-runs.ts`. Run `pnpm db:generate --name kit-plugin-events`, read the SQL and run `pnpm db:migrate`.
3. Add the `apps/web/src/api/services/events/` directory (`registry.ts`, `types.ts`, `emit.ts`, `subscribers.ts`, `app-handlers.ts`), `apps/web/src/api/services/agents/triggers.ts` and `apps/web/src/api/queues/handlers/event-deliver.ts`, and register `event.deliver` in `coreHandlers` in `apps/web/src/api/queues/jobs.ts`.
4. Port `triggers` and `bindable` on `AgentDefinition` in `apps/web/src/api/services/agents/registry.ts`, the `trigger` input and the two fields in `apps/web/src/api/services/agents/runs.ts`, and `GET /bindable` in `apps/web/src/api/routes/agents.ts`.
5. Add `EVENTS_RETENTION_DAYS` to `apps/web/src/config.ts`, and `runPruneEvents` and the `pruneEvents` task on `0 4 * * *` to `apps/web/src/api/scheduled.ts`.
6. Port `eventHandlers` on `ServerPlugin` in `apps/web/src/plugins/types.ts`, add `apps/web/src/plugins/api/emit.ts`, add `emit` to `apps/web/src/plugins/api/jobs.ts`, `http.ts` and `ai.ts` (`AgentCtx`), add `eventTrigger`, `eventBinding` and `listBindableAgents` to `apps/web/src/plugins/api/agent-runs.ts`, and re-export all of them from `apps/web/src/plugins/api/index.ts`.
7. Show `run.triggerEvent` in `apps/web/src/ui/pages/agents/AgentsPage.tsx` and `RunPage.tsx`.
8. Port the `events` manifest rules (`eventNameProblem`, `eventClashes`, `undeclaredManifestEvents`) in `scripts/lib/plugin-lib.mjs` and `plugin-lib.d.mts`, and their use in `check` in `scripts/plugin.mjs`.
9. Port `apps/web/tests/helpers/events.ts` and its re-export in `apps/web/tests/kit/integration.ts`, `emit` in `makeRequestCtx` in `apps/web/tests/kit/unit.ts`, `eventDeclarationIssues` in `apps/web/tests/helpers/plugins.ts` with its cases in `apps/web/tests/config/plugins.test.ts`, the `src/api/scheduled.ts` reason in `apps/web/tests/config/unscoped-allowlist.test.ts`, `apps/web/tests/helpers/fixture-events.ts` and `apps/web/tests/api/plugin-events.test.ts`.
10. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.

## Conflicts to expect

- `docs/plugin-api.md` → generated → regenerate, never merge by hand.
- `apps/web/src/api/services/events/app-handlers.ts` → app-owned (`manual` in `.rocketflare.json`) → add it once, then keep your own handlers.
- `apps/web/src/plugins/example-feature/` → emits, handles and ships an agent → take the kit's files if you still carry the reference plugin; skip them if you deleted it.

## Verify

1. `pnpm gate` passes.
2. `node scripts/plugin-api-doc.mjs --check` exits 0.
3. `pnpm web test:api` passes `tests/api/plugin-events.test.ts` and `src/plugins/example-feature/tests/api/example-feature.test.ts`.
4. `pnpm web test:config` passes `tests/config/plugins.test.ts`, `tests/config/plugin-lib.test.ts` and `tests/config/unscoped-allowlist.test.ts`.
5. `pnpm plugin check` prints `✔` for every installed plugin.
