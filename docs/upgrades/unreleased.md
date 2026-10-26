---
version: unreleased
previous: 0.23.0
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

Tool calls whose completion events are missing following a crash or retry surface an unknown outcome rather than silently replaying.

- `agentToolEndEventDataSchema` explicitly models `outcome` (`'success' | 'error' | 'unknown'`), and tool event reconciliation pairs `tool.start` and `tool.end` events by `toolCallId`, recording `outcome: 'unknown'` when a process stops before completion is persisted (issue #5).
- `runToolLoop` accepts pre-reconciled tool outcomes, preventing duplicate side-effect execution across retries while honestly exposing unresolved tool results in the transcript and timeline (issue #5).

## How to apply

1. Port `outcome` in `packages/shared/src/ai/agents.ts`.
2. Port reconciled tool handling in `apps/web/src/api/services/ai/kit.ts`.
3. Port tool event reconciliation in `apps/web/src/api/services/agents/runs.ts` (`reconcileToolEvents`) and `runtime.ts`.

## Conflicts to expect

- `apps/web/src/api/services/agents/runs.ts` → `reconcileToolEvents` reconciles open tool calls before retries and on settled runs.

## Verify

1. `pnpm gate` passes.
