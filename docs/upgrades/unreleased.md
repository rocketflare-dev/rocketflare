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

Independent tool calls in an agent's turn now execute concurrently with a configurable cap, preserving model-requested transcript order and existing execution policies.

- `meta.policy` (`agentPolicySchema`) gains `maxConcurrentToolCalls` (default 4; cap 1 is sequential), executed concurrently by `runToolLoop` with events, transcript results and error handling preserved in model order (issue #4).

## How to apply

1. Port `maxConcurrentToolCalls` in `packages/shared/src/ai/agents.ts` into `agentPolicySchema`.
2. Port the concurrent tool execution logic in `apps/web/src/api/services/ai/kit.ts`'s `executeToolUses`.
3. For agents whose tools share state or depend on each other, configure `maxConcurrentToolCalls: 1` on `meta.policy` to retain sequential tool execution (concurrency defaults to 4).

## Conflicts to expect

- `apps/web/src/api/services/ai/kit.ts` → `executeToolUses` gained bounded concurrency → keep your custom tool execution logic inside the handler runner.

## Verify

1. `pnpm gate` passes.
