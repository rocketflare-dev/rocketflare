---
version: unreleased
previous: 0.1.0
date: null
breaking: true
migrations: ["conversations gains a nullable rolling summary and its watermark"]
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

**A long chat now forgets deliberately instead of overflowing — new `[vars]` key and a migration.**
`CHAT_HISTORY_MAX_CHARS` (24 000) replaces a bare 40-message limit as what bounds a turn's history,
because a message count is not a limit: forty messages at the per-message cap is 1.28M characters,
which no model accepts, so a thread that hit it failed on every turn. **Add the key to BOTH wrangler
tomls or the parity test fails.** Two new nullable columns on `conversations` (`summary`,
`summarised_through_id`) carry a rolling summary of the trimmed prefix, folded in by a new
`chat.compact` job and replayed as the system prompt's volatile half. Port the schema and run
`pnpm db:generate` — never copy the kit's migration. New prompt registry key `chat-compaction`
(it appears in Settings → agent models, so you can point it at a cheap model). New notice codes
`history_truncated` / `history_summarised`.

**The chat prompt now says when NOT to use the knowledge tools.** With tools on, a small model
answered "Hello" by listing the knowledge base, picking the first document and summarising it —
13 500 input tokens, and the next turn overflowed. If you have overridden the `chat` prompt, port
that guidance into yours or the same thing will happen.

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

**The Workers AI zero-key floor is now `@cf/zai-org/glm-4.7-flash`** (was
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Measured, not assumed: it accepts `tool_choice`, its
event stream carries tool calls AND keeps producing text, its context window is 131k rather than
24k, and it is **cheaper** — $0.06 / $0.40 against $0.293 / $2.253 per million input / output
tokens. The 70B, asked a knowledge question with tools on, looped the same search until the turn cap
and emitted no text at all. A tenant that pinned a model in Settings → AI is unaffected; this is the
platform fallback only.

Two adapter fixes came with it. **Workers AI answers in two shapes** — older models return
`{ response, tool_calls }`, newer ones the OpenAI `{ choices: [{ message | delta }] }` envelope — and
reading only the first made every newer model look like it answered with nothing. And **streaming
with tools is now per-model**: `WORKERS_AI_STREAMING_TOOL_MODELS` is a live-verified allow-list (no
model documents its stream shape), so the default streams token by token with tools on and the
`workers_ai_no_token_streaming` notice no longer fires for it.

In the chat bubble, a tool call is now one row — a spinner while it runs, a tick when its result
arrives, matched by `toolCallId` — instead of a line for the call and a second "Done" line after it.

Also in Settings → AI: model suggestions are keyed BY SCOPE, so a chat config no longer offers an
embeddings model. They are still a hand-kept list rather than a live read of Cloudflare's catalog —
`wrangler ai models list` is the live one — and everything suggested is priced in
`@rocketflare/shared/ai/pricing` so the Usage page does not report `unpricedCalls`.

**Workers AI forced tools recover from one more shape.** A live `summarize-text` run failed with
`submit_summary: the model did not return valid input` while the model had in fact produced the
right content — Llama 3.3 70B wrapped it as
`{"type":"function","name":"submit_summary","parameters":{…}}` and `recoverForcedToolCall` only
unwrapped `{name, arguments}`. It now strips that envelope, `arguments` as a JSON string, and a
nested `function`, but only when the object names the tool or declares itself a function call — so
a tool whose own schema has a `parameters` field is never unwrapped. The Agents drawer also renders
an error event's `details` ("What the model returned"), which is the difference between debugging a
failed run in the UI and going to the database for it.

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

**CI now runs on pull requests.** `ci.yml` triggered only on a push to `main` and on
`workflow_call`, so no PR ever got a check — and the porting-note guard, which the docs describe as
a PR gate, could only ever run after merge. `pull_request` is added to the triggers, and the
porting-note step picks its comparison point per trigger (`pull_request.base.sha` on a PR, the
previous commit on a push). `push` stays limited to `main`, so a PR branch runs the gate once
rather than twice. `.github/workflows/**` is `manual` — read the diff before taking it.

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

### Workers AI: `tool_choice` where the model has it, and a picker that only offers those models

A forced tool was always a sentence in the system prompt on Workers AI (`forcedToolInstruction`)
plus `recoverForcedToolCall` unwrapping whatever prose JSON came back. The newer models do accept
`tool_choice`, so for them it is now sent as a real constraint and the instruction is not — one
rule, not a rule plus a plea. That removes the class of failure the recovery was patching.

`WORKERS_AI_TOOL_CHOICE_MODELS` (`services/ai/providers.ts`) is every Workers AI text-generation
model whose catalog entry declares `function_calling` AND whose input schema declares `tool_choice`
— eleven, derived from `wrangler ai models list --json` and `wrangler ai models schema`. It is **one
list doing three jobs**: the Workers AI chat picker in Settings → AI, the runtime's
`workersAiSupportsToolChoice`, and its `workersAiStreamsTools` (below). Keeping them the same set is the point — a model somebody can choose
is a model the agent runtime can constrain — so the picker no longer offers
`@cf/openai/gpt-oss-120b`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` or
`@cf/mistralai/mistral-small-3.1-24b-instruct`. **A stored config naming one of those keeps
working, stays editable and stays priced**; the picker is an affordance, never a validation rule,
and the prose fallback stays for exactly that case. `@rocketflare/shared/ai/pricing` gains the
eleven models' published rates (with the cached-input tier where the catalog has one), so nothing
newly selectable lands on the Usage page as an `unpricedCall`.

**Streamed tool calls are reassembled from fragments, and the streaming allow-list is gone.**
`WORKERS_AI_STREAMING_TOOL_MODELS` held one model; `workersAiStreamsTools` is now the same single
list, because every model on it was driven through a real two-turn tool loop and each streams the
tool call and then streams its answer as text. That exposed a bug the one-entry list had been
hiding: ten of the eleven follow the OpenAI streaming contract and send tool-call **fragments**
keyed by `index`, and the adapter treated every frame as a whole call — one broken `tool_use` per
fragment, with unparseable arguments. `ToolCallAssembler` now concatenates per index; a call
delivered whole in one frame (`glm-4.7-flash`, which is why this never showed) is the one-fragment
case of the same path. **If you added models to the streaming list, take this patch** — without it
they produce garbage tool calls. The `workers_ai_no_token_streaming` notice now fires only for an
older model a stored config still names.

**The model field is a select, not a `<datalist>`.** The old one was an `<input list=…>`, and a
browser filters datalist options by what is already in the box — with the field prefilled to the
provider's default, exactly one option showed, which read as "this provider has one model". It is
now a real dropdown, with an "Other — enter a model id…" escape for providers whose ids are open
(`modelsFixed` on the provider catalog says which). The free-text input is `autoComplete="off"`,
because otherwise the browser offered ids typed against OTHER providers — a `@cf/…` suggestion
under Anthropic.

### `get_document`'s window is capped by the caller

`GET_DOCUMENT_MAX_CHARS` (50 000) was sized for an agent run, where reading a document IS the job.
On the chat path that is most of a small model's context window in one tool result, and it is how a
thread poisons its own next turn. The cap now comes from the CALLER —
`AgentToolContext.maxDocumentChars` — and `chat-turn.ts` passes `CHAT_GET_DOCUMENT_MAX_CHARS`
(6 000); an agent run is unchanged. An over-ask is **clamped, not rejected**: a validation error
costs a turn the model usually cannot diagnose, while a short window plus `hasMore`/`nextOffset` is
a call it already knows how to make. If you build tools on `buildAgentTools`, nothing changes
unless you pass the new field.

### Cached input tokens were billed twice outside Anthropic

`TokenUsage.inputTokens` means UNCACHED input, because that is what Anthropic reports and what
`estimateCostMicrocents` prices at the input rate. OpenAI counts the other way round —
`prompt_tokens` INCLUDES `prompt_tokens_details.cached_tokens` — so a cached read was charged at
the full input rate and again at the cache rate. `fromOpenAiUsage` now subtracts it, which also
covers `openai_compatible` and `workers_ai`. Existing `ai_usage` rows keep their frozen cost; only
new ones are right. (Chat prompt caching itself needed no change: the Anthropic adapter has
defaulted `cache` to `true` since Phase 3a, so `runStreamingChat` has always sent
`cachedSystem` + `withRollingCacheBreakpoints`. The remaining gap is different and is now recorded
in `docs/CONCEPTS.md` §9 — a sliding history window moves the cached prefix every turn.)

### A chat inspector, and the per-turn model it needs — **migration**

**`conversations.provider/model` was display-only and quietly wrong.** The row froze them at
creation, but every turn calls `resolveChat` again, so a thread showed the model it was created with
long after the tenant had changed provider. Both are now refreshed each turn, and `messages` gains
nullable `provider`/`model` columns recording what actually answered each turn — the only place a
thread whose model changed mid-way can be priced or explained. **Port the schema and run
`pnpm db:generate`; never copy the kit's migration.** Existing assistant rows keep NULL and are
reported as "unknown" rather than attributed to whatever answers today.

**New surface: `GET /api/chat/conversations/:id/stats`**, admin+ (`manage AiConfig`) ON TOP of the
usual ownership filter — it widens what an owner sees about their OWN thread and never whose
threads are visible. Everything in it is derived per request from the stored rows, the live config
and the price table, so there is no state to keep in step with the transcript: which model answers
next (from `readiness()`, so opening the panel costs no tokens), the history window the next turn
will send against `CHAT_HISTORY_MAX_CHARS`, what fell out of it, the summary and how far the thread
is from its next one, turns, tool calls, tokens, cache reads/writes and an estimated cost broken
down by model. It also breaks the next prompt into its five disjoint parts — system prompt, tool
schemas, summary, your messages, replies — because "my context is full" usually has a cause, and on
a short thread it is the tool schemas and the system prompt, which are sent every turn whatever was
asked. A model the price table does not know contributes `null` and is counted in
`unpricedTurns`, the same honesty rule the Usage page already follows.

**New surface: `POST /api/chat/conversations/:id/compact`** — summarise now instead of waiting for
the automatic threshold. It enqueues (a summary is a model call, and a route never runs one) with a
new optional `force` on the `chat.compact` payload, which skips the `CHAT_COMPACTION_MIN_CHARS`
guard. **An optional field rather than a new job type**, because an old consumer reading it as
absent behaves exactly as it does today. Nothing pending is a 409 `nothing_to_compact` rather than a
cheerful 202 for a job guaranteed to no-op.

UI: a collapsible right-hand panel on `/chat`, toggled from the header and remembered in
`localStorage`, in the lazy `ChatPage` chunk — the main bundle is unchanged. It polls only while a
summary is pending and stops the moment nothing is owed.

### A document viewer at `/documents/:id`, and the three read endpoints behind it

A document was a row you only ever saw the edges of: Knowledge listed its title and chunk count,
Search showed matching passages, and **no HTTP endpoint returned `documents.content` at all** — the
text was reachable only through the `get_document` agent tool. So a person could find a passage and
never read the document it came from, and never see the PDF they had uploaded.

**New: `GET /api/ai/documents/:id/{content,passages,card}`** on the existing router, all
`read Document`, all tenant-predicated, with an unknown id and another tenant's id answering the
SAME 404 body so the API is not an existence oracle. `/content?offset=&maxChars=` is one character
window (`documentContentSchema`; default 20 000, cap 50 000, with `totalChars`/`hasMore`/
`nextOffset`); `/passages` is the stored chunks by `seq`, paginated; `/card` is the compact citation
form. A document with no text is a **409** — `document_not_converted` while its job is pending,
`document_conversion_failed` after — never an empty window.

**The windowing was EXTRACTED, not duplicated.** `services/ai/document-content.ts` is now the one
implementation and `get_document` delegates to it, which also fixes the isolate-memory behaviour on
the agent path: the tool used to pull a 500 000-character column into the isolate to slice 20 000 out
of it, and every window is now cut in Postgres. **The tool's JSON is unchanged down to key order and
the exact sentences** (`agent-tools.test.ts` asserts it) — the model reads that JSON, so a reordered
key would be a prompt change nobody wrote. If your copy has customised `get-document.ts`, take the
service and re-point your handler at it rather than keeping a second slice.

**Inline PDFs need TWO things, and the second one is the blocker.** `INLINE_MIME_TYPES` adds
`application/pdf` to the avatar images, so a PDF is served `Content-Disposition: inline` (everything
else still downloads, so a stored `text/html` or SVG can never execute on this origin). But
`securityHeaders` stamps `X-Frame-Options: DENY` + `frame-ancestors 'none'` on every response after
`next()`, and `DENY` forbids framing by ANY origin **including our own** — so the viewer's
`<object>` renders empty whatever the disposition says.

The fix is narrow and opt-in from the route: `AppVariables.embeddable`, set by `routes/files.ts`
when `isEmbeddableMimeType(row.contentType)`, and `securityHeaders` answers `SAMEORIGIN` +
`EMBEDDABLE_CONTENT_SECURITY_POLICY` for that one response. **Only a route that has proved the
content type may set the flag** — not a path allowlist (`/api/files/` would relax framing for the
`text/html` we download on purpose) and not a global policy change. Two things to port carefully:
the flag is set **before** the `If-None-Match` 304 early return (miss that and the embed works once,
then goes blank on the revalidation the `<object>` sends), and `EMBEDDABLE_MIME_TYPES` is a
**second** list rather than a flag on the first, because inline and framable are different
properties. Both policies are built from one `CSP_BASE`; a test asserts they differ in
`frame-ancestors` and nothing else. If you have edited `security-headers.ts`, merge by hand.

**The card is an excerpt, not a summary, and there is no thumbnail.** `documentCardSchema` carries
the first 320 characters of the text, whitespace-collapsed, null while a document is pending. There
is no `documents.summary` column and no server-side rasterisation on Workers (no canvas, no pdfium;
`env.AI.toMarkdown` returns text, not an image). The documented extension — not built — is a
`documents.summary` column filled by a `document.summarize` job reusing `summarize-text`.

**UI.** `/documents/:documentId` (lazy, guard `read Document`, no SideNav entry), tabs
`?tab=document|details`. A PDF embeds its original with `<object>` — **its children are the
fallback and nothing tries to detect failure**, because there is no reliable success event, which is
why the panel header always carries Download original and a Converted text toggle. Deep links:
`?offset=` snapped by `windowStart()` so a link and the reader's paging share one cache entry,
`?chunk=` when a passage's `charOffset` is null, `?q=` highlighted as `<mark>` NODES. Markdown
renders AS markdown; highlighting and the passage anchor live in the Plain toggle, since `<mark>`
cannot be threaded through react-markdown's AST.

`DocumentCard` is **markdown-free by construction**, which is what lets it live in the eagerly
imported `components/shared` barrel: it is used by Search (grouping hits under one header, built
client-side from the list that page already fetches — no N+1), by `RunDetailDrawer`'s citations, and
by `Markdown` itself, where an anchor matching `/documents/<uuid>` now renders as a card. The
markdown-importer rule in `apps/web/src/ui/CLAUDE.md` widens to `pages/documents/` — **qualified**:
`DocumentsPage` and `SearchPage` live there too and must NOT import it.

Two link changes an app may have depended on: Search's hit title was a `<button>` that wrote
`?documentId=` into the URL and is now a `<Link>` into the viewer (the filter survives as a separate
funnel button on the card), and `RunDetailDrawer`'s two citation links move from
`/search?documentId=` to `documentPath(...)`.

**Worth being explicit about:** a tenant API key can now page a whole document's text, where before
it could extract only search passages. The permission model already treated document text as
readable by any member (`POST /search` returns whole passages; `get_document` hands full windows to
any agent run in the tenant), so this widens the convenience rather than the audience — but if an
app wants it closed, the lever is a separate ability, not narrowing this one.

### Chat and agent runs cite documents as cards — `CUSTOM kit.document`

`kit.document` joins the `kit.` CUSTOM namespace (payload `{ card: documentCardSchema }`). The chat
stream emits one per document after the `TOOL_CALL_RESULT` it came from, and
`services/agents/agui-projection.ts` maps a `tool.end` row through the **same** mapper, so a
finished run reads back with the cards a live chat showed. Nothing in a Workflow step knows AG-UI
exists, and the runtime is untouched.

**Why a CUSTOM event and not the two obvious alternatives**, because this is the decision most
likely to be re-litigated. Parsing `TOOL_CALL_RESULT` in the UI couples a React component to
`search-knowledge.ts`'s internal JSON, which that file explicitly reserves the right to retune for
context budgets — a prompt change would silently break the card. AG-UI's generative-UI path needs
client-side tools, which `POST /api/agui/run` refuses today, and it makes the card a *render*
contract rather than a *data* one. `kit.document` is kit-owned, versioned, zod-validated and ignored
for free by a third-party client. An app adds its own events under its own prefix, never `kit.`.

`documentCardsFromToolResult(toolName, result)` lives in `@rocketflare/shared/ai/embeddings` rather
than in `services/` because FOUR callers need the same answer: the chat stream (the tool's JSON
string), the projection (the summarised object on the event row), and the UI rendering a PERSISTED
message from `messages.toolCalls` — which is why nothing about a card is stored and a reloaded
thread shows the same strip. It is pure, it `safeParse`s (a retuned tool degrades to "no cards", not
a crash), and it never queries, so it cannot widen tenant scope. `KNOWLEDGE_TOOLS` in the same file
is now the one place the three tool names are written; the server's `SEARCH_KNOWLEDGE_TOOL` and its
two siblings read from it.

Two schema consequences to port: `documentCardSchema`'s `typeLabel`, `contentType` and `sizeBytes`
are **nullable**, because a card built from a search hit knows the title and the passage count and
nothing else — guessing "Text" for what might be a PDF is worse than an absent badge. `ChatBubble`
gains an optional `documents` prop and `ChatTurnResult` / `StreamingTurn` gain `documents`.

## How to apply

**The document viewer needs no migration.** Take `packages/shared/src/ai/embeddings.ts` and
`src/files.ts`, then `services/ai/document-content.ts`, `routes/ai-documents.ts`,
`services/agents/tools/get-document.ts` (delegate) and `services/ai/retrieval.ts` (it exports
`chunkCharOffsetSql` now, so the passage list and a search hit cannot disagree about an offset).
`middleware/security-headers.ts`, `routes/files.ts` and `api/types.ts` are the framing half — read
that diff rather than overwriting a `security-headers.ts` you have edited. Add
`services/ai/document-content.ts` and the viewer page to `feature-knowledge`'s paths in your
`.rocketflare.json` if you still have the knowledge feature, so a later upgrade never recreates them
after you delete it. Verify with `curl -sI` on a stored PDF: `inline` + `SAMEORIGIN`, an uploaded
`.html`: `attachment` + `DENY`, any JSON route: `DENY`.

**Run the migration first** if you take the chat inspector: `messages.provider` and
`messages.model`, both nullable. Generate your own — a kit migration's snapshot describes the kit's
schema, not yours.

**Workers AI first.** If you kept the kit's provider catalog, take `services/ai/providers.ts`,
`services/ai/client.ts` and `packages/shared/src/ai/pricing.ts` wholesale. If you have added your own models to the picker,
merge by hand and check each against `wrangler ai models schema` — the list is now load-bearing for
the runtime, not just the form.

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

`middleware/security-headers.ts` if you have added a CSP directive — it is now built from a shared
`CSP_BASE` with two `frame-ancestors` variants, so a directive of yours has to move into the base or
it applies to only one of them. Any code of yours that linked to `/search?documentId=` as "open this
document"; a custom `components/shared/index.ts` barrel; and a `get_document` handler you have
customised, which is now a delegation.

**Bundle.** Measured before and after on the kit: `gzip -c apps/web/dist/api/worker.js | wc -c`
went from 1 311 621 to 1 336 048 — about 24 KB gzip, under 2%, for the schemas plus the protobuf
encoder. Measure your own; a copy near the free plan's 3 MiB script limit is the one this could
matter to.

## Verify

```
pnpm web test:config                           # agui-contract, shared-imports, ui-bundle, document-helpers
node scripts/release-check.mjs --deployable    # in an app: deployable=true
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

And, with `pnpm dev` running: upload a PDF on `/documents`, open it from the Knowledge list, and
confirm it **renders in the page** — that assertion is what proves the framing fix, not just the
disposition one. Search a phrase, click a hit, and land on the viewer at that passage with it
highlighted; the funnel button still narrows the search.

Then, with `pnpm dev` running: send a chat message and watch devtools show `data:`-only frames
carrying `RUN_STARTED → CUSTOM → TEXT_MESSAGE_* → RUN_FINISHED`; press Stop mid-stream and confirm
no error toast and no terminal frame; ask something answerable only from the knowledge base and
watch the tool steps appear.
