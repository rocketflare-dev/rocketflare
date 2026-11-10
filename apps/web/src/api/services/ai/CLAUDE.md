# AI services

The provider seam and everything that calls a model. Feature code (routes, agents) never imports an
SDK, never reads `ai_configs`, never decrypts a key — it asks `resolve.ts` for a client and calls it
through `agent-loop.ts`.

| File | Role |
|---|---|
| `types.ts` | `ChatClient { stream, complete, countTokens? }`, `EmbeddingsClient { embed, dimension }`, block-shaped `ChatMessage`/`ContentBlock`, `SystemPrompt` (`string \| { stable, volatile }`), `ChatDelta`, `RequestDefaults`, `AiEnv` (`{ AI? }`) |
| `providers.ts` | `PROVIDERS` catalog — DATA only: `scopes` (an adapter exists), `needsApiKey/BaseUrl`, `supportsThinking/ServiceTier`, presets, `suggestedModels` by scope, `modelsFixed` (the list IS the catalog → the form offers it and no free text). `WORKERS_AI_TOOL_CHOICE_MODELS` lives here and is ONE list with two jobs: the Workers AI chat picker AND `client.ts`'s `workersAiSupportsToolChoice`. Re-derive it from `wrangler ai models list --json` + `wrangler ai models schema`, and price every addition in `@rocketflare/shared/ai/pricing` |
| `client.ts` | Adapters: `createChatClient` (`anthropic` / `anthropic_compatible` via `@anthropic-ai/sdk`; `openai` via the Responses API (`/responses`, `store: false`, reasoning items round-tripped as `reasoning` blocks; `responsesBody` / `toResponsesInput` / `fromResponsesUsage` — `input_tokens` includes cached AND cache-written tokens, made disjoint here); `openai_compatible` via `/chat/completions` fetch SSE; `workers_ai` via `env.AI.run` — OpenAI-shaped inputs; answers arrive in EITHER `{ response, tool_calls }` or the OpenAI `{ choices: [{ message \| delta }] }` envelope depending on the model, both read by `readWorkersAiPart`. A forced tool is sent as `tool_choice` (OpenAI shape) for the models in `WORKERS_AI_TOOL_CHOICE_MODELS` — the list in `providers.ts` that the settings picker ALSO offers, so a choosable model is always a constrainable one. Older models named by a stored config have no `tool_choice`, and there a forced tool is `forcedToolInstruction` in the system prompt + `recoverForcedToolCall` when the model writes the arguments as a JSON object in prose, including the call envelopes models emit (`{type:'function',name,parameters}`, `arguments` as a JSON string, nested `function`) — unwrapped only when the object names the tool or declares itself a function call, and `stream()` with tools is one non-streamed call replayed as deltas unless `workersAiStreamsTools` — the SAME list — allows it; nothing documents a stream shape, so each entry was driven through a real two-turn tool loop. Streamed tool calls arrive as FRAGMENTS keyed by `index` and are reassembled by `ToolCallAssembler`), `createEmbeddingsClient` (`openai*` `/embeddings`, `workers_ai` binding). Injects `service_tier` + `thinking`, `reconcileThinking`. **The body follows the MODEL's traits** (`@rocketflare/shared/ai/models` — `modelTraits`): thinking `enabled`+budget (Claude ≤ 4.5, every `anthropic_compatible` vendor), `adaptive` (4.6+), off = `disabled` / Sonnet 5.5's `between_tools` / no field (Opus 5.5, Fable — always think); `temperature` never sent to the Claude API (API version 2026-10-21 refuses it), and to a compatible vendor only where its model takes one; a forced tool on a model that refuses one (Opus/Sonnet 5.5, Fable 5.1) becomes `forcedToolText` in the system prompt + `tool_choice: auto`; `max_tokens` floored at `ADAPTIVE_THINKING_MIN_MAX_TOKENS` while a model thinks adaptively. Thinking / redacted_thinking blocks come back as opaque `reasoning` blocks and are sent back only to the provider that produced them. **Each refusal the traits could misjudge is recovered once and remembered for the client's life** (`AnthropicQuirks` / `ResponsesQuirks`): a refused `thinking` (Fireworks' gpt-oss: "Invalid reasoning effort: none"; a misread Claude id), a refused sampling value, a refused forced tool, a refused OpenAI effort (`none` → `low`); a replayed reasoning block the API rejects (signature / prefix check) is stripped for that one call. `fetch` is injectable |
| `client.ts` (workers_ai) | `env.AI.run` cannot be aborted → every call is raced against `WORKERS_AI_TIMEOUT_MS` (120 s) into a retryable `unavailable` `AiError`. Per-model schemas differ: null content is never sent, and a schema rejection (`5006`/`oneOf`, `isWorkersAiSchemaError`) retries ONCE with `flattenWorkersAiMessages` (system/user/assistant, string content, tool call + result as text) |
| `decisions/` | The `ctx.decide` engines behind ONE seam (`types.ts`: `DecisionClient { provider, method, ask(request, { model, signal }) }`). `typesafe.ts` = TypeSafe's System One API (Jev) over plain `fetch` — the request IS the shared `DecisionRequest`; status → `AiError` via `codeForStatus`; 429/529 retried twice in-call (`TYPESAFE_RETRY_DELAYS_MS`, `sleep` injectable); a noul's confidence is derived (`|2p − 1|`, the wire carries none); a missing answer throws rather than returning a partial set. `llm.ts` = the fallback: ONE forced `submit_judgments` call whose schema has a property per question (`p_yes`, an option map, `level_<i>`), normalised, confidence from the SAME shared formulas, `method: 'llm_self_report'` |
| `resolve.ts` | `resolveDecisions(…, { fallbackSystem, wrapChat? })` — tenant `scope='decisions'` row → `TYPESAFE_API_KEY` → the chat model on `agent-decide` (`source: 'fallback'`) → the chat 503; `decisionsClientFromRow` for the connection test. `readiness()` reports `decisions` with `source: 'fallback'` when only chat is ready. Also `resolveChat` / `resolveEmbeddings` / `readiness` — tenant default row → `platformChat(cfg, env)` (`ANTHROPIC_API_KEY` → `workers_ai` + `WORKERS_AI_CHAT_MODEL` when `env.AI`) → `AiNotConfiguredError` (503 `ai_not_configured`). The ONLY reader of `ai_configs` and the ONLY decrypt. Tests `vi.mock` this module |
| `agent-loop.ts` | `cachedSystem`, `withRollingCacheBreakpoints`, `Tool` (zod schema + optional handler; no handler = terminal), `callStructuredTool` (forced tool, 1 retry; `StructuredOutputError.issues` = the zod issues or `{ reason, stopReason, text }` when there was no call), `runToolLoop` (resumable: `onCheckpoint` per turn, `resume` to continue, so `maxTurns`/usage are run-wide; `policy` — `maxTurns`/`maxToolCalls`/`maxConcurrentToolCalls` (default 4; cap 1 is sequential)/`maxDurationSeconds`/`repeatedFailureLimit` counted across attempts (active time in the checkpoint's `activeMs`, the rest from the transcript), then `onExhaustion`: `'final-answer'` forces ONE call to the single terminal tool (`salvaged: true`), `'fail'` throws `ToolLoopExhaustedError`; no policy = the old behaviour; `authorizeTool` refuses a call by rule BEFORE the gates are collected), `parseToolLoopCheckpoint` (storage → `ToolLoopCheckpoint` or **null**, never a throw), `runStreamingChat` (chat engine). **The HITL gate**: `Tool.requiresApproval` / `requiresApprovalWhen` / `approvalMessage` / `allowEdits` / `onReject`; `InterruptRequested` + `InterruptDeclinedError`; `approvals` / `onInterrupt` / `runApproved` / `beforeTurn` on `RunToolLoopOptions`; `stopReason: 'interrupt'`; `appendUserText` (never two consecutive user turns — Anthropic rejects them, and that is exactly what naive steering produces). The gate scans the WHOLE turn after the assistant message is pushed and before any handler runs, checkpoints, then raises; `resumePendingToolCalls` answers a parked checkpoint's trailing `tool_use` blocks through **the same** `executeToolUses`. `runHandler` rethrows `InterruptRequested` and ONLY that; `runStreamingChat` deliberately does not — chat has no host that can park a turn, so it drops every tool that declares a gate before the model sees the list. `ToolApproval.approvedCall` binds a go-ahead to the shown tool and arguments, once per attempt |
| `errors.ts` | `AiError { code: auth \| rate_limit \| invalid_request \| unavailable \| unknown }`, `normalizeAiError`, `describeAiError`, `redactSecrets`, `AiNotConfiguredError` |
| `usage.ts` | `recordUsage` → `ai_usage` (cost frozen from `@rocketflare/shared/ai/pricing` unless the caller passes one), `tapUsage(client, cb)`, `summarizeUsage` (prices rows with no stored cost from the same table; `unpricedCalls` counts what has no price at all) |
| `connection-test.ts` | `testConfig` — 10-token completion / one embedding / one `noul` question (decisions), same builders as the resolver, never throws a provider error |
| `deterministic-embedding.ts` | `deterministicEmbedding` (hashed bag of words, `EMBEDDING_DIM` wide, L2-normalised, never zero) + `DETERMINISTIC_EMBEDDING_MODEL = 'seed:deterministic'` — for `pnpm seed --demo` and the test `RecordingAi` stub ONLY; nothing on the request path imports it, so the Worker bundle never carries it (`grep -rn deterministic-embedding apps/web/src` must list only this file) |

Rules:

- **One resolve seam.** `resolveChat(db, cfg, env, tenantId, { promptKey? })` / `resolveEmbeddings`
  / `resolveDecisions` are the ONLY readers of `ai_configs` / `agent_models` and the only decrypt;
  the platform tier is `platformChat(cfg, env)` — never re-derive the chain in a route. Callers go
  through `agent-loop.ts` (`runStreamingChat`, `runToolLoop`, `callStructuredTool`). No client →
  `AiNotConfiguredError` thrown before any row is written or any stream opens. Tests
  `vi.mock('@/api/services/ai/resolve')` (`// @vitest-isolate`) and hand in `FakeChatClient`
- **Credentials never leave the server.** Rows leave as `hasCredential`; every provider failure
  goes through `normalizeAiError` → `AiError { code }` with a `redactSecrets`'d message; the user
  sees `describeAiError(err)`, never the vendor body. Encrypt at the route with
  `encrypt(key, requireEncryptionKey(cfg))` (`auth/oauth-encryption.ts`)
- **Per-tenant request defaults live in the adapter**, never at call sites. Thinking is OFF unless
  a config turns it on; `reconcileThinking` drops a BUDGET on forced tool choice and lifts
  `max_tokens`. What a MODEL accepts is `modelTraits(provider, model)`
  (`@rocketflare/shared/ai/models`) — never branch on a model id anywhere else; a new model is a
  row in the traits test.
- **Reasoning stays in the loop.** A `reasoning` block is replayed verbatim within a tool loop and
  kept in checkpoints, never written to chat history; editing an earlier assistant turn invalidates
  its signature, so transcripts are append-only.
- **`recordUsage(db, …)` on every model call**: `feature` is the prompt key or `agent:<key>`, cost
  filled from `@rocketflare/shared/ai/pricing` at write time (pass `costMicrocents` only to
  override; an unknown model stays null). Chat records after the stream, on the stream's client.
  An agent records nothing itself — the run's meter does (`../agents/CLAUDE.md`)
- **Trace every LLM call**: `withAgentTrace(name, { tracer, tenantId, userId, conversationId |
  runId, … }, trace => traceChatClient(client, trace, { provider }, tracer))`. Its span is ACTIVE
  (`observability/context.ts`), so tool spans (`runHandler`'s `traceToolCall` — never trace a tool
  yourself), `searchChunks`' `retrieval` span and `traceEmbed` batches nest with no extra
  parameter; `traceStep` nests anything else. Never add a `trace` parameter to a service. `tracer`
  is `withAuth`'s in a route, `ctx.tracer ?? noopTracer` in a job, and in a Workflow step
  `tracerFor(cfg, { store: databaseSpanStore(db) })`, flushed BEFORE the step's client closes.
  Attribute names only in `genai-attributes.ts`
- **Wrap, don't fork.** Tracing (`traceChatClient`) and usage (`tapUsage`) are client wrappers; a
  new cross-cutting concern is another wrapper, never a fork of the adapter.
- **Streaming (`chat-turn.ts` is the ONE implementation; `routes/chat.ts` and `routes/agui.ts` wrap
  it).** Resolve, authorise, validate and write anything that can fail as JSON BEFORE the stream
  opens — after the first frame a failure can only be a `RUN_ERROR`. Transport is hono's
  `stream(c, cb)` + `createAguiEncoder(c.req.header('Accept'))` — **never `streamSSE`** (its
  `writeSSE` adds an `event:` line and pins the content type; AG-UI frames are `data:` only);
  `encodeBinary` covers SSE and protobuf. Inside, `streamDatabase(c)` for every write, closed in
  `finally`; await every write and the tracer flush (no `defer` after the Response). A cancelled
  run emits NOTHING — neither `RUN_FINISHED` nor `RUN_ERROR` IS the signal
- Adding a provider: enum value in `@rocketflare/shared/ai/config` (append last) → `PROVIDERS` entry →
  adapter branch in `client.ts` → `ai-client.test.ts` case. Per-agent model assignment
  (`agent_models`) is `resolveChat`'s `promptKey` branch (`planChat` — shared with
  `routes/ai-agent-models.ts`).
- **Prompts are code**: a `CORE_PROMPT_REGISTRY` entry in `../prompts.ts` (title, description,
  `variables`, `defaultText`), read through `resolvePrompt(db, tenantId, key, vars)` — never a
  hard-coded string in a route or agent; no migration.
- **Evals drive the real code in-process**: `apps/evals` calls the chat route and the agent step
  bodies inside `withEvalScope` (marks traces `rocketflare.eval=true`). Nothing in the Worker
  enters that scope — never add a request flag for it. The judge is the `evals-judge` prompt; its
  spend is `ai_usage` feature `evals.judge`
- **Ingest**: `chunking.ts` (paragraph-aware, ~800 tokens / 100 overlap, 4 chars per token);
  `ingest.ts` — `ingestText(db, cfg, env, input, { jobs })` and `ingestFile(db, cfg, env, input, {
  jobs, storage })` (original to R2 as a `files` row scope `documents`, `fileId` on the document).
  Text-like types index inline ≤ 50 chunks else a `document.index` job; PDF/Office/HTML enqueue
  `document.convert` (`convertAndIndexDocument`). `indexDocument` is shared with the handlers.
  Everything that can 503 (`resolveEmbeddings`, `canConvert`) runs BEFORE any write; the upload
  route maps `ConversionNotConfiguredError` → 503 `conversion_not_configured`;
  `ConversionFailedError` is the permanent case
- **Strip NULs before storing**: every stored text — `documents.content`, `chunks.text`, every
  `ai_spans` string — goes through `stripControlChars` / `stripControlCharsDeep`
  (`utils/core/text.ts`); Postgres refuses a NUL in `text` (22021) and `jsonb` (22P05), and
  converted PDFs carry them
- **An `externalId` makes ingest an upsert**: the same `(tenant, source, externalId)` updates the row
  in one `ON CONFLICT` (partial unique index), replaces its grants, rebuilds its chunks and drops a
  replaced R2 original; `deleteExternalDocument` is the delete. Plugins reach both only through
  `@/plugins/api` (`ingestDocument`, `deleteIngestedDocument`)
- **Retrieval only through `searchChunks(db, cfg, env, scope, request)`** (`retrieval.ts`): dense
  `<=>` + lexical over ANY query word (`anyTermTsquery` — never `websearch_to_tsquery`, which ANDs
  filler words into zero hits) ranked by `ts_rank_cd`, RRF `k = 60`; `RerankFn` is the documented,
  unbuilt seam. **A document's TEXT only through `document-content.ts`** (`readDocumentWindow` /
  `listDocumentPassages` / `readDocumentCard`), which `get_document` and `GET
  /api/ai/documents/:id/{content,passages,card}` both call — never a second slice in JS, never a
  `select()` over `chunks` that could widen onto `embedding`
- **Reading takes an `AccessScope`, not a tenant id**: `searchChunks` and the three readers all take
  one (built at EXECUTE time for an agent run, from `requestedByUserId`), so a restricted document
  is absent from search, `get_document` and the viewer alike; `documentId` narrows the tenant
  predicate, never replaces it. `fullAccessScope(tenantId)` is for maintenance paths only. The dense
  half sets `hnsw.iterative_scan = relaxed_order` (`SET LOCAL`, in a transaction) WHEN a visibility
  predicate is in play — otherwise the index can exhaust its candidates and return nothing
- **Platform documents** (`platform-documents.ts`): `tenant_id` NULL, readable by every tenant.
  `ingestPlatformText` resolves `resolvePlatformEmbeddings(cfg, env)` (`EMBEDDINGS_API_KEY` →
  `[ai]` → null; never a tenant's row) BEFORE anything else, so no embedder means
  `PlatformEmbeddingsError` and nothing written. It embeds every chunk before its transaction
  opens, so a provider failure leaves the old revision, and it is a no-op for the same title, text
  and model. `prunePlatformText` deletes what a sync no longer has. Only `@/plugins/api` calls them
  (Job/Cron contexts). `searchChunks(…, { sources?, platformSources?, signal? })` reaches them by
  named source only, with a platform dense leg ranked by the PLATFORM query vector and limited to
  documents embedded by that model. It shares one leg with the tenant corpus when both models
  match, else uses one leg per model (`fuseDenseLegs`). `searchKnowledgeChunks` adds provenance and
  `semantic`, and `lexicalFallback` turns a missing tenant embedder into keyword-only search.
  Without the new params `searchChunks` answers exactly as before
- `DELETE /api/ai/documents/:id` deletes the R2 original too (`deleteStoredFile`); `/api/files`
  refuses a `documents`-scope delete with 409 `owned_by_document`
