---
version: unreleased
previous: 0.9.0
date: null
breaking: false
migrations:
  - "new tenant table ai_spans (the local trace store, RLS policy included)"
  - "trace_id text column on agent_runs and messages"
areas: [api, shared, db, cli, config, docs]
touches_surfaces: [feature-chat, feature-agents, feature-knowledge]
requires_surfaces: []
manual: false
---

## What changed

AI tracing now exports vendor-neutral OTLP spans with GenAI conventions — nested model, tool, retrieval and embeddings spans — to Langfuse, Phoenix or any backend, and records them locally for `rocketflare traces`.

- The Langfuse ingestion client (`observability/langfuse-fetch.ts`, deprecated by Langfuse on 2026-11-16) is replaced by an OTLP/HTTP exporter (`otlp-fetch.ts`; JSON, or protobuf via `otlp-protobuf.ts` for Phoenix). No new dependency. Rationale: `docs/CONCEPTS.md` §9 (D32, supersedes D16).
- `TraceHandle` nests: `span()` returns a child handle, and there are new `toolCall()`, `setAttributes()`, `traceId` and `spanId` members. Existing plugin calls still compile. `id` is now the 32-hex OTLP trace id instead of a uuid.
- Every attribute name lives in `observability/genai-attributes.ts`. The active span is carried by `AsyncLocalStorage` (`observability/context.ts`), and the kit's one tool runner (`kit.ts` `runHandler`) traces every tool.
- Coverage: chat turns, each agent `execute#N` step and the run root (derived ids: trace id = the run uuid's hex; root recorded by the `finish` step), `searchChunks`, embeddings, and the `chat.compact` / `document.index` / `document.convert` jobs.
- New table `ai_spans`, written on every flush, whether or not a backend is configured. A nightly `pruneAiSpans` task on `0 4 * * *` keeps `OBSERVABILITY_SPAN_RETENTION_DAYS` (default 14).
- New `GET /api/traces` and `GET /api/traces/:id` (the id may be a trace id, a run id or a message id). Both need the new `Trace` subject (admin+ `read`). New CLI commands `rocketflare traces list|show` and a new `rf-traces` skill.
- Config: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS` (secret), `OBSERVABILITY_PRESET` (`langfuse|phoenix|generic`), `OBSERVABILITY_CAPTURE_CONTENT` (default `true`), `OBSERVABILITY_TRACE_URL`, `OBSERVABILITY_SPAN_RETENTION_DAYS`. Existing `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` select the langfuse preset automatically, so no new secret is needed.
- `JobContext` gains an optional `tracer`, which the consumer flushes before the job's client closes. `executeRun` takes an optional `{ round }`. `finishStep` takes an optional `{ cfg }`, and only the workflow's `finish` step passes it.

## How to apply

1. Port `apps/web/src/api/observability/` whole: delete `langfuse-fetch.ts`, and add `context.ts`, `genai-attributes.ts`, `otlp-fetch.ts`, `otlp-protobuf.ts`, `recorder.ts`, `span-store.ts`, `trace-ids.ts`. Then replace `tracer.ts` and `tracing.ts` with the kit's versions.
2. Add `apps/web/src/db/schema/ai-spans.ts`, export it from `apps/web/src/db/schema/index.ts`, and add the `traceId` column to `agent-runs.ts` and `messages.ts`. Then run `pnpm db:generate` and `pnpm db:migrate`. Never copy the kit's migration file.
3. Add the seven `OTEL_*`/`OBSERVABILITY_*` keys to `apps/web/src/config.ts`. Add `OBSERVABILITY_CAPTURE_CONTENT = "true"` and `OBSERVABILITY_SPAN_RETENTION_DAYS = "14"` to `[vars]` in BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, then run `pnpm types`.
4. Add the observability block to `apps/web/.dev.vars.example`, and add `OTEL_EXPORTER_OTLP_HEADERS` to `apps/web/.provision.env.example` and to `OPTIONAL_WORKER_SECRETS` in `apps/web/scripts/provision/config.ts`.
5. Wire the call sites from the kit's diff:
   - `middleware/tracing.ts` passes `ownConnectionSpanStore`.
   - `services/ai/kit.ts` calls `traceToolCall` in `runHandler`.
   - `chat-turn.ts` passes `conversationId` and stores `traceId` on the assistant row.
   - In `services/agents/runtime.ts`, `executeRun` uses `databaseSpanStore(db)` and derived ids, and `recordRunRoot` runs in `finishStep`.
   - `workflows/agent-run.ts` passes `{ round }` and `{ cfg }`, and `services/agents/runs.ts` mints the run id and `traceId`.
   - `retrieval.ts` and `ingest.ts` wrap with `traceStep`/`traceEmbed`.
   - `queues/jobs.ts` builds a per-message tracer, and the three AI handlers call `withAgentTrace`.
6. Add `runPruneAiSpans`/`pruneAiSpans` to `apps/web/src/api/scheduled.ts` under `'0 4 * * *'`.
7. Add `packages/shared/src/ai/traces.ts` and its line in `packages/shared/src/ai/index.ts`. Add `'Trace'` to `CORE_SUBJECTS` in `packages/shared/src/permissions.ts`, and add `can('read', 'Trace')` to `grantAdmin` in `apps/web/src/permissions/abilities.ts`.
8. Add `apps/web/src/api/services/traces.ts` and `apps/web/src/api/routes/traces.ts`, and add the `['/api/traces', tracesRouter]` entry to the mount table in `apps/web/src/api/index.ts`.
9. Add `apps/cli/src/commands/traces.ts` and the `traces` command block in `apps/cli/src/cli.ts`, and copy `.claude/skills/rf-traces/`.
10. Re-export the new members from `apps/web/src/plugins/api/observability.ts` and `apps/web/src/plugins/api/index.ts`, then run `node scripts/plugin-api-doc.mjs`.
11. If your app calls `withAgentTrace` or `tracerFor` itself, pass `runId` or `conversationId` instead of `sessionId` where one applies. In a Workflow step or a job, pass `store: databaseSpanStore(db)` to `tracerFor` and flush before the client closes.

## Conflicts to expect

- `apps/web/src/api/observability/*` → rewritten → take the kit's files, then re-apply any local attribute additions in `genai-attributes.ts`.
- `apps/web/src/api/services/agents/runtime.ts` → `executeRun` and `finishStep` signatures gained a trailing optional argument → keep your changes and add the trace fields to the `withAgentTrace` call.
- `apps/web/tests/api/observability.test.ts` → replaced → take the kit's file.
- `apps/web/tests/api/scheduled*.test.ts` → the nightly cron now reports two tasks → add `pruneAiSpans` to your expectations.
- `apps/web/tests/config/permissions.test.ts` → new `Trace` matrix row → add it.

## Verify

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
2. `pnpm cli traces list` after one chat turn shows an `invoke_agent chat` trace, and `pnpm cli traces show <messageId>` prints `chat <model>` and `execute_tool` children.
3. `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"` logs `pruneAiSpans: removed expired trace spans`.
4. With Langfuse keys set, a chat turn appears in Langfuse as a nested trace with no new secret added.
