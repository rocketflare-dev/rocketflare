---
version: unreleased
previous: 0.16.3
date: null
breaking: false
migrations:
  - "memories, memory_entities, memory_entity_links and memory_groups tables (pgvector HNSW, generated tsvector + GIN, RLS policies)"
  - "conversations.memory_retained_through_id watermark column"
areas: [api, db, shared, ui, cli, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The assistant can now remember dated facts people tell it in chat and recall them across conversations, private to each person, behind a per-tenant `memory` flag that is off by default.

- New tables `memories` (two clocks: `mentioned_at` and `occurred_start/end`; stored `search_vector`), `memory_entities`, `memory_entity_links` and `memory_groups`; `conversations.memory_retained_through_id` ([CONCEPTS §9 Memory](../CONCEPTS.md)).
- `memory.retain` job: enqueued after each chat turn while the tenant has the flag. It learns from the person's own turns only, drops near-duplicates, supersedes changed facts and compare-and-sets the watermark.
- `recall_memory` agent tool (dense + lexical + entity arms, RRF, ISO `from`/`to` filter): it is offered in chat and agent runs only when memory is on for that person.
- `/api/memory` (list, entities, forget one, forget all, settings) behind `requireFeature('memory')`, Profile → Memory panel, `rocketflare memory list|forget`.
- `visibleMemories(scope)`: the D29 admin bypass never reaches a `private` memory. It is registered as the `memory` `VISIBILITY_RESOURCES` entry, so `group_in_use` counts `memories`.
- `CORE_FEATURES` is `['memory']` (it was empty); `CORE_SUBJECTS` gains `Memory` (`manage` for every role, own rows only); the `memory-extraction` prompt is added and the `chat` prompt gains a paragraph on `recall_memory`.
- `removeMember` deletes the removed person's memories and entities in that tenant; `fuseRankedArms` (N-arm RRF) is exported from `services/ai/retrieval.ts`.

## How to apply

1. Copy `packages/shared/src/ai/memory.ts` from the kit and add `export * from './memory'` to `packages/shared/src/ai/index.ts`.
2. In `packages/shared/src/jobs.ts`, add `memoryRetainPayloadSchema` and the `memory.retain` variant to `CORE_JOB_VARIANTS`.
3. In `packages/shared/src/permissions.ts`, append `'Memory'` to `CORE_SUBJECTS` and add `'memory'` to `CORE_FEATURES`. In `packages/shared/src/features.ts`, add the `memory` entry to `CORE_FEATURE_FLAGS` (`defaultState: 'off'`).
4. Copy `apps/web/src/db/schema/{memories,memory-entities,memory-groups}.ts`, export all three from `apps/web/src/db/schema/index.ts`, and add `memoryRetainedThroughId` to `conversations.ts`. Then run `pnpm db:generate --name kit-memory`, read the SQL, and run `pnpm db:migrate`.
5. Copy `apps/web/src/api/services/ai/memory/` (`settings.ts`, `store.ts`, `recall.ts`, `retain.ts`), `apps/web/src/api/queues/handlers/memory-retain.ts`, `apps/web/src/api/services/agents/tools/recall-memory.ts` and `apps/web/src/api/routes/memory.ts`.
6. Register `'memory.retain': handleMemoryRetain` in `coreHandlers` (`apps/web/src/api/queues/jobs.ts`), and mount `['/api/memory', memoryRouter, requireFeature('memory')]` in `apps/web/src/api/index.ts`.
7. Port the kit's edits to `services/access.ts` (`visibleMemories` + `memoryVisibility` in `CORE_VISIBILITY_RESOURCES`), `services/ai/retrieval.ts` (`fuseRankedArms`), `services/agents/tools/{index,search-knowledge}.ts` (`AgentToolContext.memory`, the conditional `recallMemoryTool`), `services/agents/runtime.ts` (`memory: await memoryEnabledFor(...)`), `services/ai/chat-turn.ts` (the `memory` flag, the `memory.retain` enqueue, the tool when `CHAT_KNOWLEDGE_TOOLS=false`), `services/members.ts` (the purge in `removeMember`) and `services/prompts.ts` (`memory-extraction`, the `chat` paragraph).
8. Grant `can('manage', 'Memory')` in `grantAdmin` and in `member` in `apps/web/src/permissions/abilities.ts`.
9. Copy `apps/web/src/ui/hooks/useMemory.ts` and `apps/web/src/ui/pages/ProfileMemory.tsx`, add the `memory` family to `apps/web/src/ui/lib/query-keys.ts`, and render `<ProfileMemory />` in `pages/Profile.tsx` when `session.features` includes `memory`.
10. Copy `apps/cli/src/commands/memory.ts` and register the `memory list` and `memory forget [id] --all` commands in `apps/cli/src/cli.ts`.
11. Add `'memory-extraction'` to any test that pins the prompt-key list, `'memory.retain'` to any test that pins `CoreJobType`, and a `Memory` row to any test that pins the ability matrix.
12. Turn memory on for a tenant from `/admin/feature-flags` (an override, or a rollout). Nothing changes for any tenant until that is done.

## Conflicts to expect

- `apps/web/src/api/services/ai/chat-turn.ts` → `prepareChatTurn` gained the memory flag, an enqueue and a `buildTools` branch → keep your own tools and add the kit's three edits beside them.
- `apps/web/src/api/services/prompts.ts` → the `chat` default text gained a paragraph → if you overrode or rewrote that prompt, add the `recall_memory` paragraph to your text yourself.
- `packages/shared/src/features.ts` → `CORE_FEATURE_FLAGS` was `{}` → merge the `memory` entry beside your own flags.

## Verify

1. `pnpm db:migrate` applies the new migration, and `pnpm web test:api` passes, including `tests/api/memory.test.ts` and `tests/api/rls-coverage.test.ts`.
2. With no override row for the tenant, `curl -s localhost:3001/api/memory` (signed in) answers 404 with code `feature_disabled`.
3. With the flag on for a tenant, a chat message like "I moved to Lisbon in March" enqueues `memory.retain`, and a new thread asking "where do I live?" calls `recall_memory`.
4. `rocketflare memory list --json` parses with `memoryListResponseSchema`.
