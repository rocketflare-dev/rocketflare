---
version: unreleased
previous: 0.21.0
date: null
breaking: false
migrations: []
areas: [api, shared]
touches_surfaces:
  - feature-agents
requires_surfaces: [feature-agents]
manual: false
---

## What changed

Independent tool calls in an agent's turn now execute concurrently with a configurable cap, preserving model-requested transcript order and existing execution policies. Tool calls whose completion events are missing following a crash or retry surface an unknown outcome rather than silently replaying.

- `meta.policy` (`agentPolicySchema`) gains `maxConcurrentToolCalls` (default 4; cap 1 is sequential), executed concurrently by `runToolLoop` with events, transcript results and error handling preserved in model order (issue #4).
- `agentToolEndEventDataSchema` explicitly models `outcome` (`'success' | 'error' | 'unknown'`), and tool event reconciliation pairs `tool.start` and `tool.end` events by `toolCallId`, recording `outcome: 'unknown'` when a process stops before completion is persisted (issue #5).
- `runToolLoop` accepts pre-reconciled tool outcomes, preventing duplicate side-effect execution across retries while honestly exposing unresolved tool results in the transcript and timeline (issue #5).

## How to apply

1. Port `maxConcurrentToolCalls` and `outcome` in `packages/shared/src/ai/agents.ts`.
2. Port the concurrent tool execution and reconciled tool handling in `apps/web/src/api/services/ai/kit.ts`'s `executeToolUses`.
3. Port tool event reconciliation in `apps/web/src/api/services/agents/runs.ts` (`reconcileToolEvents`) and `runtime.ts`.
4. For agents whose tools share state or depend on each other, configure `maxConcurrentToolCalls: 1` on `meta.policy` to retain sequential tool execution (concurrency defaults to 4).

## Conflicts to expect

- `apps/web/src/api/services/ai/kit.ts` → `executeToolUses` gained bounded concurrency and reconciled tool bypass → keep your custom tool execution logic inside the handler runner.
- `apps/web/src/api/services/agents/runs.ts` → `reconcileToolEvents` reconciles open tool calls before retries and on settled runs.

## Verify

1. `pnpm gate` passes.
