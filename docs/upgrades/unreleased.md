---
version: unreleased
previous: 0.1.0
date: null
breaking: true
migrations: []
areas: [api, ui, shared, config, docs]
touches_surfaces: [feature-chat, feature-agents]
requires_surfaces: []
manual: false
---

## What changed

### AG-UI is the wire protocol for chat and agent runs — **breaking**

`packages/shared/src/ai/agui.ts` carries the contract, built on `@ag-ui/core` (pinned exactly: its
schemas ARE the wire format, so a bump is a protocol bump). It exports `kitAguiEventSchema` — a
discriminated union over exactly the events the kit emits, never `@ag-ui/core`'s full set — plus
the `kit.` CUSTOM namespace (`KIT_CUSTOM_EVENTS`, `kitCustomPayloadSchema`, `parseKitCustom`) where
every kit-specific semantic lives, `chatRunResultSchema`, and `kitRunAgentInputSchema` +
`readRunAgentTail`.

**New surface: `POST /api/agui/run`.** The AG-UI `RunAgentInput` endpoint, mounted beside
`/api/chat` behind the same `authMiddleware` — a session cookie, or a tenant API key as Bearer
(which `csrf.ts` already exempts); a cross-origin browser client needs its origin in the CORS
allow-list, which is configuration, not code. **Conversation ownership is still the `userId`
filter, so every thread an API key touches belongs to the user who created that key.** The
reconciliation rule is "the server is the transcript, the client supplies only the tail": an
unknown `threadId` is adopted, the last message is the new user turn and earlier ones are ignored,
a replayed UUID message id is not re-inserted, and `MESSAGES_SNAPSHOT` tells the client in-band
what the server believes. A non-empty `tools[]` is refused with 400, not ignored. It is a wrapper:
the same `streamChatTurn` the chat route calls.

**An agent run reads back as AG-UI too.** `GET /api/agents/runs/:id/agui` projects
`agent_run_events` at read time — plain JSON, same ownership rules as `GET /runs/:id`. The table
and the runtime are untouched; nothing in a Workflow step knows AG-UI exists. There is no SSE
endpoint for runs: a run executes in another isolate, so live streaming is a feature, not a mapping.

**Chat now calls the knowledge tools by default.** `search_knowledge`, `get_document` and
`list_documents` — the same three every agent gets — are on `POST /conversations/:id/messages`, so
the chat box answers from the workspace's own material. It costs more tokens per turn, and on
Workers AI, which has no tool-call event stream, the reply stops arriving token by token and comes
in bursts per model turn (the server says so once, as `CUSTOM kit.notice`). **Set
`CHAT_KNOWLEDGE_TOOLS = "false"` in BOTH wrangler tomls to keep the old behaviour** — and add the
key to both either way, or the parity test fails. The loop is capped by `CHAT_MAX_TOOL_TURNS` (6),
not `AGENT_MAX_TURNS` (30): a chat turn is interactive and shares the Worker's budget with the
request that opened it.

**`packages/shared` gained a third dependency.** The rule is amended, with its reason intact, in
both `packages/shared/CLAUDE.md` and the root `CLAUDE.md`: `@ag-ui/core` is zod-only with no
platform APIs, so it bundles into the browser and loads in the CLI, and a wire format has to be
validated by the same runtime schema on both sides. It is confined to `src/ai/agui.ts` and the rule
is now machine-checked by `apps/web/tests/config/shared-imports.test.ts` rather than
documentation-only. A fourth dependency needs the same written justification.

The deploy workflow now asks whether there is anything to deploy before it tries. The kit's own
repository keeps `<PLACEHOLDER>` ids in both wrangler tomls on purpose — that is what stops a copy
deploying before it is provisioned — so every tag the kit cut went red at the parity check. A
permanently red deploy is one nobody reads, and a real failure would hide in it.

A `guard` job runs `node scripts/release-check.mjs --deployable` and the two deploy jobs are
conditional on it. **Nothing changes for an app:** a copy has an `app` block in
`.rocketflare.json`, so it always deploys, and still fails loudly at the parity check if it was
never provisioned. Only the kit itself, still carrying placeholders, is skipped — with a notice
saying why.

The decision is `isDeployable` in `scripts/lib/upgrade-lib.mjs`, unit-tested, because the expensive
mistake here is a false skip: somebody's production release quietly not happening. Every ambiguous
case deploys.

## How to apply

**Decide about chat tools first.** `CHAT_KNOWLEDGE_TOOLS` must be added to BOTH wrangler tomls or
the parity test fails; `"false"` keeps the old, cheaper, always-token-streaming behaviour.

**Then the protocol.** Take the patch for `packages/shared/src/ai/agui.ts`,
`apps/web/src/api/services/ai/{agui,chat-turn}.ts`, `routes/{chat,agui}.ts`,
`services/agents/agui-projection.ts`, `src/ui/lib/{sse,aguiStream}.ts` and `hooks/useChat.ts`, and
install the dependencies: `@ag-ui/core` in `packages/shared`, plus `@ag-ui/core`,
`@ag-ui/encoder` and `@ag-ui/proto` in `apps/web`. **Pin all four exactly** — the schemas are the
wire format.

The old→new frame mapping, for any code of yours that read the stream:

| was | is |
|---|---|
| `message.start` | `CUSTOM kit.chat.ids` (the same ids, `messageId` → `assistantMessageId`) |
| `text.delta` | `TEXT_MESSAGE_CONTENT` — **one text message per model turn**, so accumulate across `messageId`s |
| `tool.start` | `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` |
| `tool.end` | `TOOL_CALL_RESULT` (the tool's own JSON; no error flag in 0.0.59) |
| `usage` | `CUSTOM kit.usage`, mirrored into `RUN_FINISHED.result` |
| `message.end` | `RUN_FINISHED` |
| `error` | `RUN_ERROR` |
| *(nothing)* | a cancelled run closes with **no terminal event** — that IS the cancellation signal |

If your copy added variants to `chatStreamEventSchema`, they become CUSTOM events under your OWN
prefix — never `kit.`, which a later kit release may extend (`docs/ADAPTING.md` §3b).

`.github/workflows/**` is `manual`, so read that diff before taking it — if you have changed your
deploy workflow, port the `guard` job and the two `if:` conditions by hand rather than overwriting
yours.

## Conflicts to expect

Anything of yours that touched the chat stream: a custom `chatStreamEventSchema` variant, a
`readSse` call site (it takes a `parse` argument now), an import of `lib/chatStream.ts` (deleted —
`lib/aguiStream.ts`, and `sendChatMessage` is `runChatTurn`), a bespoke chat UI switching on
`text.delta`, a test using `sseFrames`/`sseResponse` (`aguiFrames` and the `aguiRun` helper), and
**anything keying on the SSE `event:` field**, which is gone: the type is `JSON.parse(data).type`.

`.github/workflows/deploy.yml` if you have edited it, which most apps do.

**Bundle.** Measured before and after on the kit: `gzip -c apps/web/dist/api/worker.js | wc -c`
went from 1 311 621 to 1 336 048 — about 24 KB gzip, under 2%, for the schemas plus the protobuf
encoder. Measure your own; a copy near the free plan's 3 MiB script limit is the one this could
matter to.

## Verify

```
pnpm web test:config                           # agui-contract, shared-imports, ui-bundle
node scripts/release-check.mjs --deployable    # in an app: deployable=true
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Then, with `pnpm dev` running: send a chat message and watch devtools show `data:`-only frames
carrying `RUN_STARTED → CUSTOM → TEXT_MESSAGE_* → RUN_FINISHED`; press Stop mid-stream and confirm
no error toast and no terminal frame; ask something answerable only from the knowledge base and
watch the tool steps appear.
