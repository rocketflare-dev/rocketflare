# 09 — AI enablement layer

Providers & settings, the provider abstraction, chat, the agent runtime, prompts,
observability, embeddings/retrieval and evals. Sources:

- **Mirevue** (`~/work/mirevue`) — Hono + React on Node, `pg`, pg-boss, Anthropic-shaped
  clients everywhere. **Primary reference for this whole subsystem.**
- **GuideMode server** (`~/work/guidemode/apps/server`, "GM") — Cloudflare Workers. A much
  simpler `promptJSON` seam, but it proves three things run in Workers that the kit needs:
  `@anthropic-ai/sdk` over fetch, a SigV4 Bedrock call via `aws4fetch`, and a fetch-based
  Langfuse ingestion client flushed in `waitUntil`. **CF-compat reference only.**

**Verdict up front.** Take Mirevue's AI layer wholesale as the structural base — the
config model (env defaults → tenant provider rows → per-agent model assignment), the
Anthropic-shaped provider seam with its request-default and tracing wrappers, `agent-kit`'s
tool loop + streaming chat, the durable `agent_runs`/`agent_run_events` runtime, the prompt
registry, and the shared SSE progress protocol + React hooks. All of it is already written
against `fetch` and WebCrypto except five Node-shaped pieces: pg-boss, `LISTEN/NOTIFY`
(`pg-notify.ts`), the OTel `NodeSDK` Langfuse bootstrap, `@anthropic-ai/bedrock-sdk` (and the
AWS SDK embeddings path), and the boot-time `process.env` config. Each has a Workers
replacement below, and GM already has two of them. **Do not adopt the Vercel AI SDK**: every
non-trivial thing in this layer (rolling cache breakpoints, `withRequestDefaults`,
`reconcileThinking`, the tracing tap, the tool loops) is built on the Anthropic `.messages`
surface and would be thrown away for a thinner abstraction.

One correction to the brief: **Mirevue's knowledge-base embeddings are NOT
`@huggingface/transformers`.** That dependency is only the browser voice stack
(`src/ui/lib/voice/*.ts`, `scripts/copy-ort-wasm.mjs`, and a static-serving shim in
`src/server.ts:38-63`). KB embeddings are a plain `fetch` to an OpenAI-shaped `/embeddings`
(`src/api/services/ai.ts:457-484`) — Workers-safe as-is.

---

## 1. AI settings and configuration

### 1.1 Env level (Mirevue `src/config.ts`) — names only

| Var | Role | `config.ts` |
|---|---|---|
| `ANTHROPIC_API_KEY` | Platform fallback chat key, used only when the tenant has no `global` config | `:41-43` |
| `EMBEDDINGS_API_KEY` | Platform fallback embeddings key (OpenAI-shaped) | `:45-48` |
| `AGENT_MAX_OUTPUT_TOKENS` (default 16384) | Per-call `max_tokens` when the tenant config has none | `:50-58` |
| `AGENT_MAX_TURNS` (default 30) | Turn cap for every tool loop | `:50-58` |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT` | Tracing is on only when both keys are set | `:60-75` |
| `OAUTH_ENCRYPTION_KEY` | Also encrypts the stored provider credentials | `:26` |

Defaults live beside the schema: `DEFAULT_ANTHROPIC_MODEL` (`:177`), `DEFAULT_EMBEDDINGS_MODEL`
(`:184`). Mirevue's `.env.example` names the same set; nothing AI-specific is hidden elsewhere.
`AiEnv` (`src/api/services/ai.ts:32-40`) is the narrow slice the resolver needs — a good
seam to keep because on Workers it becomes `Pick<Bindings, …>` from `c.env` with no other change.

### 1.2 Tenant level — `tenant_ai_configs`

`src/db/schema/tenant-ai-configs.ts`. One row per **(tenant, featureScope, provider)**
(`:118-122`), where `featureScope ∈ {global, embeddings}` (`:27`) and `provider` is a pg enum of
eight values (`:29-38`). Columns that matter:

- `isDefault` with a **partial unique index** `(tenant, scope) WHERE is_default` (`:125-127`) —
  "no default" and "two defaults" are unrepresentable. The route auto-promotes the first row
  saved per scope (`routes/ai-config.ts:364-369`).
- Credentials: `encryptedApiKey`, `encryptedAwsAccessKeyId`, `encryptedAwsSecretAccessKey`
  (`:61-67`), AES-GCM via **WebCrypto** (`src/api/auth/oauth-encryption.ts:30-79`) — portable to
  Workers unchanged. Provider-shape columns: `baseUrl`, `azureDeploymentName`, `azureApiVersion`,
  `awsRegion`.
- Request defaults: `model`, `maxOutputTokens`, `serviceTier` (free text, per-provider
  vocabulary, `:70-82`), `thinking` (varchar holding `NULL`=disabled or a `budget_tokens`
  integer, `:83-100`).
- Audit `createdBy/updatedBy`, RLS via `tenantIsolation('tenant_ai_configs')`.

The browser-safe contract is `src/shared/ai-config.ts`: `aiConfigSchema` is the **sanitized**
view (`hasApiKey`/`hasAwsCredentials` flags, never the secret — `:228-256`),
`upsertAiConfigSchema`/`updateAiConfigSchema` (`:200-220`), `aiProviderInfoSchema` (`:230-243`),
the thinking helpers (`parseThinking`/`serializeThinking`/`resolveThinking`/
`thinkingRequestParams`/`validateThinkingBudget`, `:61-175`), and the test-connection contract
(`testAiConnectionSchema`, `aiConnectionTestResponseSchema` with three statuses
`ok | not_configured | failed`).

Routes `src/api/routes/ai-config.ts` (all `guardPermission(c,'manage','Tenant')`):
`GET /providers` (`:217`, catalog + `defaultMaxOutputTokens`), `GET /` (`:230`),
`POST /test` (`:265`, 1-token completion or one embed, rate-limited per tenant),
`POST /` upsert-on-conflict (`:295`), `PATCH /:id` (`:390`), `DELETE /:id` (`:500`).

The **provider catalog** is `src/api/services/ai-providers.ts` `PROVIDERS[]` — per provider:
`scopes` (which form sections offer it — an *adapter exists* gate, `:24-31`), `requiredFields`,
`optionalFields`, `suggestedModels`, `embeddingModels`, `serviceTiers`, `supportsThinking`,
`reasoningModels` (measured cost trap list). Helpers `providersForScope`, `suggestedModelsFor`,
`providerLabel` (`:279-293`).

### 1.3 Per-agent model selection — `tenant_agent_models`

`src/db/schema/tenant-agent-models.ts`: `(tenantId, promptKey) → configId + model`, unique per
`(tenant, promptKey)` (`:66`), `configId` FK **cascades** so deleting a provider reverts its
agents to the default (`:47-52`). The roster of assignable agents is the **prompt registry**
(`promptKey` is a `PromptKey`, `:31-42`) — no enum, no migration to add an agent.

Contract `src/shared/agent-models.ts` (`agentModelsStateSchema = {agents, configs, assignments}`,
`upsertAgentModelSchema`); routes `src/api/routes/agent-models.ts` `GET /` (`:32`),
`PUT /:promptKey` (`:78`), `DELETE /:promptKey` (`:139`). UI `src/ui/pages/settings/AgentModels.tsx`
(303 lines, one `AgentRow` per registry entry with a config+model picker and a reasoning-model
warning).

**Resolution order** (`src/api/services/ai.ts:291-349`, `resolveAnthropicClient(db, tenantId,
env, promptKey?)`): enabled `global` rows → pick `isDefault` → if `promptKey` given and an
assignment points at one of those rows, swap to that row+model → `buildClientFromConfig`
(`:129-213`) → else platform `ANTHROPIC_API_KEY` + `DEFAULT_ANTHROPIC_MODEL` → else
`ServiceUnavailableError`. `resolveAgentModel` (`:230-262`) is the metadata-only twin for page
loads (never builds a client, returns `null` instead of 503). `describeAnthropicReadiness`
(`:365`) feeds the Home setup checklist (`src/shared/tenant-setup.ts:19-26`, `AIReadiness`).

### 1.4 Cost/usage tracking, rate limits, budgets

- **No usage/cost table exists in either repo.** Token usage is captured only into Langfuse
  `usageDetails` (`src/api/observability/tracing.ts:91-107`, includes `cache_read` /
  `cache_creation`). Budgets exist only in the evals harness (`evals/eval.config.yaml`
  `run.maxBillUsd`).
- Rate limits: `rate_limit_hits` (`src/db/schema/rate-limit-hits.ts`) is a sliding window keyed
  by string; the connection test uses it per tenant (20/min, CONCEPTS §2.2). On Workers this is
  KV (GM `RATE_LIMIT_KV`, `src/api/services/rate-limiter.ts`) — covered by analysis 04.

### 1.5 GM's shape, for contrast

- Env: `AI_PROVIDER` (one of `gemini|openai|anthropic`), `AI_MODELS` (comma list; index 0 =
  default, 1 = "stage1", 2 = "stage2" — `ai-config/resolver.ts` `buildPlatformConfig`),
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`; `LANGFUSE_ENABLED` as an explicit flag.
  (`types.ts` still reads `CLAUDE_API_KEY` while `env.ts` declares `ANTHROPIC_API_KEY` — a drift
  bug, do not carry.)
- Tenant table has the same core as Mirevue plus `stage1Model`/`stage2Model` and
  `lastHealthCheckAt/Status/Error` (`ai-config/health-check.ts`).
- `featureScope` is **per feature** (`'global'|'giulia'|'session_processing'|'aiva'|'notebook'|
  'survey_authoring'`, `ai-config/types.ts`) — one row per consumer, resolved
  specific-then-global. Mirevue's per-*agent* assignment table over a shared provider row is the
  better design: credentials are entered once, model choice is per agent, and a new agent needs
  no schema change.

### 1.6 Recommendation — the kit's config model

**Base: Mirevue, entire section.** Keep the three tiers exactly: platform env defaults →
tenant `ai_configs` rows (one per scope+provider, one default per scope, encrypted creds) →
`agent_models` (promptKey → config + model, absence = default). Keep `serviceTier`/`thinking`
columns (they are cheap and the thinking default-off rationale in CONCEPTS §2.0.1 is real
money). Keep the three-state connection test.

CF-compat: `AiEnv` comes from `c.env`; `AGENT_MAX_*` become `[vars]`; keys become secrets.
Strip/genericize: rename tables `tenant_ai_configs → ai_configs`, `tenant_agent_models →
agent_models` (still tenant-scoped, the prefix is redundant in a kit); reduce the `ai_provider`
enum to the v1 set (§2.4) but keep it an enum with the "append values last" note; drop
`azureDeploymentName/azureApiVersion` unless Azure ships; drop the Rewired/Knowledge-base
section of `AIProvider.tsx` (`:891-1050`) and the rerank note (`:44-79`). GM's
`lastHealthCheck*` columns are worth adopting so the settings card can show "last tested".

---

## 2. Provider abstraction

### 2.1 Mirevue's layer

There is deliberately **no provider interface** — every consumer receives an
`AnthropicLikeClient = Anthropic | AnthropicBedrock` (`ai.ts:48`) and calls
`client.messages.create/.stream`. Non-Anthropic vendors are reached through their
**Anthropic-compatible** endpoints via `new Anthropic({ apiKey: null, authToken, baseURL })`
(`ai.ts:169-183`; catalog `ANTHROPIC_COMPATIBLE_BASE_URLS` in `shared/ai-config.ts` — Moonshot,
Fireworks). Two prototype-delegating wrappers compose around the raw client, both in the
`Object.create(client, { messages })` shape so `.withResponse()` and `MessageStream` survive:

- `withRequestDefaults(client, defaults)` (`shared/ai-config.ts`) injects `service_tier` and
  `thinking` into every body, and `reconcileThinking` fixes `max_tokens` headroom / strips
  thinking on forced tool choice. Per-tenant, per-request params applied where the client is
  **built**, not at 30 call sites.
- `traceAnthropicClient(client, model)` (`observability/tracing.ts:159-217`) taps `create` and
  `stream`, emitting one Langfuse `generation` per call.

`agent-kit.ts` is the "how to call it" library: `cachedSystem` (stable/volatile system split with
`cache_control`), `withRollingCacheBreakpoints` (last two messages), `callStructuredTool` (forced
single tool call = structured output; `input_schema` is JSON Schema, zod parse happens in the
caller), `runToolLoop` (agentic loop with terminal tool, `onTurn`/`onEvent`, `AbortSignal`), and
`runStreamingChat` (multi-turn streaming with tools; `delta|progress|retract` events;
`bufferText` + `BUFFERED_LEAD_IN_CHARS=180` for narration suppression; `speechTools`).

Errors: `describeAiError` (`ai-errors.ts`) maps `APIError.status` / smithy `$metadata` to an
actionable sentence, checks account-exhaustion patterns first, never echoes the body;
`redactSecrets` + `describeProviderFailure` for the admin-facing test result. **No retry
layer** beyond the Anthropic SDK's built-in (2 retries default) — the queue's `retryLimit: 2`
is the agent-level retry.

Streaming reaches HTTP as **SSE via `hono/streaming` `streamSSE`** everywhere (chat:
`routes/rewired.ts:198`, `routes/interviews.ts:2036`; agent progress:
`utils/routes/agent-progress.ts`). WebSockets are only for notifications. Clients parse SSE with
a hand-rolled `fetch` + `ReadableStream` reader (`src/ui/lib/agentProgress.ts`,
`streamMessage.ts`, `rewiredChat.ts` — three near-identical `dispatchFrame` copies).

### 2.2 GM's layer

`GiuliaAIClient { promptJSON<T>(prompt, {systemInstruction}); healthCheck() }`
(`giulia-ai-client.ts`) — JSON-only, non-streaming, no tools. `client-factory.ts` switches on
provider to Gemini/OpenAI/Anthropic wrappers (from a workspace package), an Azure OpenAI
`fetch` wrapper, and **`BedrockWrapper` using `aws4fetch`** (`ai-config/bedrock-wrapper.ts`) —
a SigV4-signed `POST https://bedrock-runtime.<region>.amazonaws.com/model/<id>/invoke` with the
Anthropic body. Too thin for chat/agents, but the Bedrock wrapper is the CF-native pattern.

### 2.3 CF-compat assessment

| Piece | Status on Workers |
|---|---|
| `@anthropic-ai/sdk` (Mirevue 0.68, GM 0.74) | fetch-based; GM runs it in production. `MessageStream` works. |
| Anthropic-compatible vendors via `authToken`+`baseURL` | same SDK, zero extra code. |
| `@anthropic-ai/bedrock-sdk` | depends on `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/credential-providers`, `@smithy/eventstream-serde-node` (the **streaming** path is Node-only). Do not ship in v1. |
| `@aws-sdk/client-bedrock-runtime` (Titan embeddings, `bedrock-embeddings.ts`) | heavy, node-flavoured; replace with `aws4fetch` if Bedrock embeddings are ever wanted. |
| `openAiEmbed` / `cohereRerank` (`ai.ts:457-537`) | plain `fetch` — fine. |
| `withRequestDefaults`, `traceAnthropicClient`, `agent-kit.ts` | pure JS — fine. |
| Workers AI binding (`env.AI.run`) | GM `learn-search.ts:58`; embeddings only in practice. |

Vercel AI SDK vs raw SDK vs Mirevue's layer: the AI SDK would give one `streamText` across
vendors, but would cost the cache-breakpoint discipline, the thinking/tier request defaults, the
tracing tap, and both loops — and the kit still needs Anthropic-specific bodies for the
providers it actually wires. **Keep Mirevue's own layer.** If a genuinely OpenAI-shaped chat
provider is wanted later, add it as a second `buildClientFromConfig` branch behind a tiny
`MessagesLike` interface (`create`, `stream`) rather than switching frameworks.

### 2.4 Recommendation — v1 provider set

- **Chat (`global` scope):** `anthropic` (direct) + `anthropic_compatible` (generic
  `baseUrl` + bearer token; Fireworks/Moonshot become presets in `PROVIDERS` rather than enum
  values). Bedrock chat: documented extension using GM's `aws4fetch` shape *without* streaming,
  or `AnthropicBedrock` once the SDK's fetch handler is confirmed on `nodejs_compat`.
- **Embeddings scope:** `openai` / `openai_compatible` (existing `openAiEmbed`), plus
  `workers_ai` (`env.AI.run('@cf/baai/bge-…')`) as the zero-key default — see §7 for the
  dimension caveat.
- Keep `PROVIDERS[].scopes` as the "adapter exists" gate so a saveable-but-unusable provider
  never reaches the form (Mirevue's own stated lesson, `ai-providers.ts:14-31`).

---

## 3. Chat

### 3.1 What exists

Mirevue has two chat surfaces on one engine:

- **Rewired "ask the book"** — `routes/rewired.ts:168-256`. Stateless: history comes in the
  request body (`askRewiredSchema`), the route resolves the client *before* the stream so a
  config error is a JSON 503, builds two tool surfaces (`createRewiredToolSurface`,
  `createKbToolSurface`), then `streamSSE` → `withAgentTrace` → `runStreamingChat` with
  `onEvent` writing `delta` (JSON-encoded text), `progress` (`{tool, detail}`), then a final
  `done` (`{answer, citations}`) or `error`. Client `src/ui/lib/rewiredChat.ts`, component
  `src/ui/pages/rewired/RewiredChat.tsx` (199 lines; messages state, `AgentSteps` for tool
  progress, `react-markdown`+`remark-gfm` rendering).
- **Interviews** — persisted conversations. Schema `src/db/schema/interviews.ts`: `interviews`
  (tenant, session, user, kind, status, several domain jsonb columns) and `interview_messages`
  (`role` enum `user|assistant`, `content`, `redactedAt`, `:83-101`). Route
  `POST /:id/messages` (`routes/interviews.ts:1908`): permission via `withEngagement(..., {
  subject:'Interview', access:'member', writable:true })`, resolve client with the kind's
  `promptKey`, assemble system prompt, insert the user message, stream the reply, persist the
  assistant message on completion. System prompt assembly (`resolvePrompt`, `:339-347`): registry
  prompt (with per-workshop override) + attendee framing + **non-overridable invariants**
  appended after, + tool guidance + a volatile block (`withVolatile`, `:386`) so the stable part
  stays cacheable (`cachedSystem`). Extra SSE frames (`meta`, `scale`, `scores`, `coverage`,
  `state`, `auditing`) are domain-specific.
- UI pieces: `pages/interviews/ChatBubble.tsx` (memoized DaisyUI bubble, markdown for assistant
  turns), `InterviewConversation.tsx`/`InterviewChat.tsx` (composer, streaming append, tool-step
  strip), `components/shared/AgentSteps.tsx` + `shared/agents/tool-labels.ts` (human labels for
  tool calls — one vocabulary for chat and run log), `components/shared/Markdown.tsx`,
  `ModelBadge`.

Tenant scoping: every query carries `tenantId` and the tables have `tenantIsolation`; the tool
handlers receive `scoped` (not `db`) because they run after the handler returned
(`rewired.ts:180-184`) — on Workers that constraint disappears (no pinned connection), but the
"resolve everything before opening the stream" rule stays.

### 3.2 Recommendation

**Base: rewired route shape + interviews persistence, genericized.** Ship:

- Schema `conversations` (`id, tenantId, userId, title, promptKey, model, status, createdAt,
  updatedAt`) and `messages` (`id, tenantId, conversationId, role, content, toolCalls jsonb?,
  createdAt`) — `interviews` minus its domain columns.
- Routes `POST /api/chat/conversations`, `GET /api/chat/conversations[/:id]`,
  `POST /api/chat/conversations/:id/messages` (SSE), `DELETE`. Permission: CASL `Conversation`
  subject, owner-or-manage, from the auth kit.
- Engine: `runStreamingChat` unchanged; frames `meta | delta | progress | done | error`.
- Client: one shared SSE reader (`src/ui/lib/sse.ts`) replacing the three copies, a
  `useChatStream` hook, `ChatBubble`, `Markdown`, `AgentSteps`, `ModelBadge`, and a
  `ChatPanel` page. Tool use in chat: keep the `AgentToolSurface {tools, handlers}` pattern
  (`agent-kb-tools.ts:63-66`) with **zero** default tools; the KB search tool arrives with §7.

CF note: `streamSSE` works on Workers (GM does not use it, but Hono's streaming helpers are
runtime-agnostic). For long tool loops, use `c.executionCtx.waitUntil` for the post-stream
persistence write so the response can end before the DB write lands.

Strip: citations parsing, `speechTools`/`bufferText` narration logic (keep the options, they
are 40 lines), quick-fire/scale/coverage frames, voice.

---

## 4. Agents

### 4.1 Contracts (`src/shared/agents/`)

- `run.ts`: `AGENT_KEYS` (8 Mirevue agents), `agentRunStatusSchema`
  `queued|running|complete|failed|cancelled|skipped`, `isRunActive`, `isRunBenign`, and
  `AGENT_META: Record<AgentKey,{traceName, promptKey, tags}>` shared by server and the
  `system-flow` UI diagram.
- `tool-labels.ts`: `AGENT_TOOL_LABELS`, `humaniseToolName`, `toolLabel(tool, overrides)`.
- `../agent-progress.ts`: the SSE protocol — `meta {model}`, `stage {key,label,status,detail}`,
  `transcript` (`text | tool_call | tool_result` with `turn`, `toolUseId`), `result`, `error`,
  `done`. Zod schemas; the UI parses with `safeParse`.

### 4.2 Definition shape (`src/api/services/agent-runtime.ts`)

```ts
interface AgentDefinition<Output, Result, Ctx> {
  agentKey: AgentKey; concurrency: 'exclusive' | 'coalesce'
  terminalTool: string; terminalToolDescription: string
  terminalToolInputSchema: Record<string, unknown>      // JSON Schema for the model
  outputSchema: { parse(v: unknown): Output }            // zod, applied to terminal input
  buildSurface(deps): Promise<{tools, handlers, userMessage, context} | {skip, result}>
  persist(deps, output, {runId, context}): Promise<Result>
  previewMessage(context: string): string               // dry-run path
  broadcast(deps): unknown; precheck?(deps); onLifecycle?(deps, phase, {error?})
  toolLabels?: Record<string,string>
}
interface ContinuousAgentDefinition { workFn(deps, ctx: AgentWorkContext) }  // multi-stage
```

Prompt and model are **not** on the definition: both resolve from `AGENT_META[agentKey]
.promptKey` (`resolvePromptValue`, `resolveAnthropicClient`). `AgentWorkContext.resolveFor
(promptKey)` lets a multi-stage agent use a different model per stage. Registry:
`agent-registry.ts` `AGENT_DEFINITIONS: Record<AgentKey, AnyAgentDefinition>`.

### 4.3 Runtime, queue, log

- `enqueueRun(def, deps, {debounceSeconds?, reprocess?})` (`agent-queue.ts`): resolve client
  first (503 before any write) → `precheck` → insert `agent_runs` `queued` → `boss.send` with
  `singletonKey = <tenantId>:<sessionId>` (+ `startAfter` debounce) → store `jobId`; a `null`
  jobId means the singleton dropped it → delete row, return `{enqueued:false, reason:'busy'}`.
  Queue policy from `def.concurrency`: `exclusive` → pg-boss `exclusive`, `coalesce` →
  `stately`; `expireInSeconds` 30 min, `heartbeatSeconds` 60, `retryLimit` 2 with backoff.
- `runAgent(def, deps, {runId, attempt, reprocess})` (`agent-runtime.ts`): **claim** via
  `UPDATE agent_runs SET status='running', model, attempt WHERE id AND status IN
  (queued,running) RETURNING` (0 rows → `skipped`); `createRunLogger`; `AbortController` in a
  module `inflight` map; `withAgentTrace(...)` around `runToolLoop`; on terminal tool →
  `outputSchema.parse` → `persist`; statuses written with `turns`/`stopReason`/`error`;
  `describeAiError` for `APIError`.
- `cancelAgent(def, deps)`: mark rows `cancelled`, `boss.cancel(jobId)`, abort local
  controller, `pg_notify(AGENT_RUN_CANCEL_CHANNEL)` so whichever replica owns the loop aborts.
- `recoverOrphanedRuns` at boot: `queued|running` older than 60 s whose job is not live →
  `failed: 'Interrupted by a restart'`.
- `agent-run-log.ts`: `RunLogger {stage, complete, transcript, result, error, done}` appends to
  `agent_run_events` with per-run `seq` and `pg_notify(AGENT_RUN_EVENTS_CHANNEL)`;
  `readRunEvents(db, tenantId, runId, afterSeq)`; `describeTurn` builds the stage label from
  tool names.
- Schema: `agent_runs` (`agent-runs.ts` — tenant, sessionId, `agentKey text`, status enum,
  `jobId`, `attempt`, `model`, `turns`, `stopReason`, `error`, timestamps; status index for
  the sweep) and `agent_run_events` (`agent-run-events.ts` — `bigserial id`, `runId`, `seq`,
  `event`, `data jsonb`, unique `(run_id, seq)`).
- Worker (`agent-worker.ts`): `boss.work` per agent queue, `localConcurrency:1`; also
  `PLAIN_QUEUES` (non-agent jobs) and a maintenance cron. `runQueuedJobsOnce` drains
  synchronously for tests.
- Progress to UI: `streamRunProgress(c, {tenantId, runId})` (`utils/routes/agent-progress.ts`)
  is a pure **reader**: `meta` from `agent_runs.model`, replay from `Last-Event-ID`/`afterSeq`,
  then wake on `LISTEN` or 1 s poll, 30 min ceiling, `done` when the row settles. Routes also
  call `def.broadcast(deps)` → `NotificationService.broadcast` (`notification.ts`, e.g.
  `mapValidator:updated`) so list views refetch. `streamAgentProgress(c, run, meta)` is the
  inline (non-queued) variant used by dry-runs.
- UI: `src/ui/lib/agentProgress.ts` (`streamAgentAction`, `useAgentAction` → `{stages,
  transcript, result, model, status, error, run, reset}`), `components/shared/AgentProgress.tsx`
  (stage checklist), `AgentTranscript.tsx` (paired call/result rows), `AgentProgressModal.tsx`
  (title, `ModelBadge`, cancel, `waitingMessages` compact mode for single-turn agents).

### 4.4 Generic vs Mirevue-specific

Generic: everything in §4.1–4.3 except `AGENT_KEYS`/`AGENT_META` contents, `sessionId` on
`agent_runs` (Mirevue's engagement scope), and the `broadcast` implementations. Mirevue-specific
and **not** for the kit: `map-validator`, `map-validator-applier`, `sequencing`,
`domain-map-extract`, `context-classifier`, `interview-graph`, `replay-synthesis`,
`domain-conviction-curator`, their tool surfaces (`agent-kb-tools.ts`,
`agent-domain-write-tools.ts`), `runAgentPreview`'s coupling to the prompt dry-run, and the
`PLAIN_QUEUES` document pipeline.

### 4.5 Recommendation and the CF handoff contract

**Base: Mirevue runtime verbatim; example agent shaped like `context-classifier`**
(`context-classifier.ts:312-336`: `exclusive`, a `precheck`, one terminal tool, no handlers,
`persist` writes a result row) — the simplest real definition. The kit's example:
`summarize-text` — input `{text}` from a small `agent_inputs`/request body, terminal tool
`record_summary {summary, keywords[]}`, persists to `agent_results`, broadcasts
`agentRun:updated`. One page lists runs and opens `AgentProgressModal` on a live one.

Schema changes: replace `sessionId` with a nullable `subjectType text` + `subjectId uuid`
(what the run is about) and add `input jsonb` (the enqueue payload, so a retry re-reads it
from the row not the queue message) and `triggeredByUserId`.

**Requirements the pg-boss → CF Queues/Workflows mapping (other agent) must satisfy** — these
are the semantics, not the mechanism:

1. **Claim is the row, not the queue.** Keep `UPDATE … WHERE status IN (queued,running)
   RETURNING` as the idempotency gate; a redelivered message that finds the row settled is a
   no-op. CF Queues has no `singletonKey`/`stately` policy, so `exclusive` becomes "insert
   `queued` only if no active row for `(tenant, agentKey, subject)`" checked in `enqueueRun`,
   and `coalesce` becomes "at most one `queued` row; a running one sets `rerun_requested`".
   Debounce = a Workflow `step.sleep` or a delayed queue message (`delaySeconds`).
2. **Progress is durable in `agent_run_events`**; the DO hub only *wakes* viewers
   (`{runId, seq}`) — replay always reads Postgres so a reconnect works from any isolate.
   `streamRunProgress` keeps its shape: SSE from the Worker, wake via DO instead of `LISTEN`.
3. **Cancellation** = row flip + a DO-hub message to the isolate holding the `AbortController`.
   Because the `inflight` Map is per-isolate, the cancel signal must be routed by `runId` through
   the hub (or the run itself polls `agent_runs.status` between turns — cheap and simpler; the
   loop already checks `signal.aborted` per turn).
4. **Long runs**: a queue consumer has a 15 min wall clock; `AGENT_MAX_TURNS=30` tool loops
   can exceed it. Recommend **Workflows** for agent runs (per-turn steps give retry + durable
   state) and Queues for plain jobs. `attempt` maps to the step retry count.
5. **Orphan sweep** moves to a cron trigger (GM `scheduled.ts` pattern).

---

## 5. Prompts

`src/shared/prompts/`: `registry.ts` (`PROMPT_REGISTRY: Record<PromptKey, PromptDefinition>` —
`key, label, description, category, default, builderGuidance (server-only), runner, sample,
maxLength`; helpers `effectivePrompt`, `isPromptKey`, `allPromptDefinitions`), `defaults.ts`
(plain string constants, 870 lines, plus non-overridable `INTERVIEW_INVARIANTS`), `samples.ts`
(dry-run fixtures), `contracts.ts` (zod for `/api/prompts/*`), `CLAUDE.md` (the how-to).

Storage: overrides only — `workshop_prompt_overrides (tenantId, sessionId, promptKey, value)`,
absence = default, revert = delete (`services/prompts.ts` `resolvePromptValue`,
`setPromptOverride`). **No versioning, no templating engine**: variable content is assembled in
code (`resolvePrompt`, `withVolatile`) and the system prompt is split stable/volatile for
caching. Routes (`routes/prompts.ts`): list state per session, `PATCH` override, `POST /build`
(Prompt Builder: an LLM rewrites the prompt under `builderGuidance`), `POST /dry-run` (runs the
real agent's compute path against the sample, persisting nothing). UI
`pages/workshops/settings/PromptEditor.tsx`.

**Recommendation.** Base: Mirevue. Kit ships `registry.ts` with two keys (`chat`,
`summarize-text`), `defaults.ts`, `contracts.ts` stripped of feature imports, overrides table
rescoped to **tenant** (`prompt_overrides (tenantId, promptKey, value)`), a settings page
`Settings → Prompts` with edit/revert, and the **Prompt Builder** (small, generic, valuable).
Dry-run: ship for the `chat` runner only (stream a reply), since structured dry-runs need per-agent
compute functions. Defer templating (keep the documented convention: static text in registry,
dynamic context appended in code as the volatile block). The registry-as-roster convention
(`agent_models` keys on `PromptKey`) is the single best idea to carry: one place to add an
agent, and settings/models/prompts pick it up.

---

## 6. Observability

`src/api/observability/`:
- `langfuse.ts`: `initLangfuse(config)` builds an OTel `NodeSDK` with `LangfuseSpanProcessor`
  (`@langfuse/otel`), enabled only when both keys exist; `langfuseEnvironment()`;
  `shutdownLangfuse()` flushes on exit (`src/server.ts:19,125`).
- `tracing.ts`: `withAgentTrace(ctx, fn)` — `startActiveObservation(name, …, {asType:'agent'})`
  + `propagateAttributes({userId, sessionId, tags, metadata})`; no-op when disabled.
  `traceAnthropicClient` (above) emits `generation` observations with model, input messages,
  `max_tokens/temperature/top_p`, output content, and `usageDetails` incl. cache tokens.
- `trace-names.ts`: TTL-cached tenant/session **names** for readable dashboards.

What is traced: every generation (via the client wrapper) nested under one `agent` span per
run/chat turn, tagged per `AGENT_META.tags`. Tool calls are *not* separate spans (they appear in
the `transcript` log, not Langfuse). Cost is computed by Langfuse from model + usage.

**CF-compat.** `@opentelemetry/sdk-node` and `@langfuse/tracing`'s AsyncLocalStorage context
do not run in Workers. Options: (a) `@microlabs/otel-cf-workers` — works but adds an OTel
dependency for one exporter; (b) **GM's `LangfuseTracer`** (`guidemode/.../services/langfuse.ts`)
— builds `trace-create`/`generation-create` events in memory and `POST`s
`/api/public/ingestion` in `flush()`, called from `waitUntil`; wrapped as
`LangfuseTracingClient` around the client. Proven in production.

**Recommendation.** Keep Mirevue's two seams and their no-op defaults —
`withAgentTrace(ctx, fn)` and `traceAnthropicClient(client, model)` — but back them with a
**thin `Tracer` interface** (`startTrace`, `generation`, `flush`) whose only v1 implementation
is GM's fetch ingestion. Per-request tracer instance on `c.var`, flushed via
`executionCtx.waitUntil(tracer.flush())`; for queued/Workflow runs flush at end of step. Keep
`toUsageDetails` (cache-aware totals) and `trace-names` (use `caches.default` or KV for the
TTL). Env: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
`LANGFUSE_TRACING_ENVIRONMENT`. Drop `LANGFUSE_ENABLED` (presence of keys is the switch, per
Mirevue).

---

## 7. Embeddings, retrieval, knowledge base

- **Extension:** `CREATE EXTENSION IF NOT EXISTS vector` (`migrations/0011_*.sql:1`);
  `vector(1024)` columns on `prep_chunks` and `rewired_chunks`; HNSW `vector_cosine_ops` index +
  GIN on a **generated** `tsvector` column (`db/schema/search.ts`, `prep-chunks.ts:70-76`).
  `EMBEDDING_DIMENSIONS = 1024`, `embeddingModel` stored per row.
- **Provider:** `ResolvedEmbeddingsClient {embed(texts), model, rerank?, rerankModel?}`
  (`ai.ts:448-454`); `openAiEmbed` sends `dimensions: 1024`; Bedrock Titan via AWS SDK
  (`bedrock-embeddings.ts`, one invoke per text, concurrency 6); `resolveEmbeddingsClient`
  reads the `embeddings`-scope default row, falls back to `EMBEDDINGS_API_KEY`;
  `describeEmbeddingsReadiness` for the checklist; `resolvePlatformEmbeddingsClient` for the
  global Rewired corpus (pinned model).
- **Retrieval:** `prep-kb.ts` `retrieve()` (`:491`) — dense candidates + `lexicalSearch`
  (strict then OR, `retrieval-ranking.ts`) → `fuseByRank` RRF with `RRF_K=60`
  (`src/documents/rank/fusion`, `shared/retrieval.ts`) → optional `cohereRerank` → layer
  authority prior → citations. Chunking is `src/documents` (out of scope).
- **GM:** `env.AI.run('@cf/baai/bge-base-en-v1.5', {text})` → `env.VECTORIZE_INDEX.query(vec,
  {topK})` (`routes/learn-search.ts:44-70`); bindings `[ai] binding="AI"`, `[[vectorize]]
  binding="VECTORIZE_INDEX"`. No pgvector.

**Recommendation.** Ship a **minimal seam in v1**: `embeddings` scope in `ai_configs`,
`resolveEmbeddingsClient` with `openai`/`openai_compatible` (fetch) + `workers_ai` (binding), a
`documents`/`chunks` table pair with `vector(N)` + generated `tsvector`, `embedTexts()` and
`searchChunks(tenantId, query, topK)` doing cosine + lexical + RRF (the fusion helper is ~100
lines and pure). No rerank, no layers, no reindex UI in v1 — documented extension, keeping
`RerankFn` on the client type so it slots in. pgvector on Neon is the CF-native store (Vectorize
would split tenant data out of Postgres and lose RLS); Workers AI is the zero-config embedder.

**Dimension caveat:** `@cf/baai/bge-base-en-v1.5` is 768-d, `bge-large` 1024-d;
`text-embedding-3-small` supports `dimensions`. Pick 1024 with `bge-large-en-v1.5` as default so
OpenAI/Fireworks remain interchangeable, and keep Mirevue's invariants: store `embeddingModel`
per row, warn on model change, connection test checks vector width (`ai-connection-test.ts:232`).

---

## 8. Evals

`evals/` is a 60-file CLI workspace (`pnpm eval`, `evals/cli.ts`) that drives the real
interviewer endpoint and agents against committed cases, with a judge model, calibration
certificates, human review sheets, and a priced `maxBillUsd` ceiling (`eval.config.yaml`).
The `/evals` UI (`src/ui/pages/evals/`, 50 files) and `routes/admin-eval-*.ts` **spawn the CLI
as a child process** (`eval-launcher.ts:1`), read artifacts from the filesystem, use their own
Postgres on 5434, and **404 in production** (`admin-eval-runs.ts:63-66`).

**Recommendation: defer entirely.** Nothing here runs on Workers, and it is wholly shaped by
the interviewer. Carry forward as documentation only: the money rules (price before run, hard
ceiling, one paid slot), "a judge is trusted only after calibration against human review", and
the idea that agents expose a pure `compute()` separable from `persist()` so cases can be run
without writes — that last one is a design rule for the kit's `AgentDefinition` docs.

---

## 9. Node-only inventory and replacements

| Node-only (Mirevue) | Where | Workers replacement |
|---|---|---|
| pg-boss queue, `boss.work` pollers | `agent-queue.ts`, `agent-worker.ts` | CF Workflows (agent runs) + Queues (plain jobs); `agent_runs` row as claim (§4.5) |
| `LISTEN/NOTIFY` (`pg-notify.ts`) for progress wake + cancel | `agent-run-log.ts`, `agent-runtime.ts`, `agent-progress.ts` | DO hub `publish({runId, seq})`; cancel by status poll per turn or hub message |
| `@opentelemetry/sdk-node` + `@langfuse/otel` + AsyncLocalStorage | `observability/langfuse.ts`, `tracing.ts` | GM fetch ingestion tracer + `waitUntil` flush behind the same `withAgentTrace` seam |
| `@anthropic-ai/bedrock-sdk` (smithy node eventstream) | `ai.ts:185-202` | defer; `aws4fetch` non-streaming as extension |
| `@aws-sdk/client-bedrock-runtime` Titan embeddings | `bedrock-embeddings.ts` | defer or `aws4fetch` |
| Boot-time `process.env` zod config | `config.ts` | zod-parse `c.env` once per isolate (analysis 04) |
| Module-scope `inflight` Map, `ensuredQueues`, trace-name cache | `agent-runtime.ts`, `agent-queue.ts`, `trace-names.ts` | per-isolate is fine for caches; cancel must not rely on it (§4.5 #3) |
| `setTimeout(...).unref()` poll loop | `agent-progress.ts` | plain `setTimeout` in the SSE loop; 30 min ceiling stays under Worker limits only if the stream is client-driven — cap at ~5 min and let the client reconnect with `Last-Event-ID` |
| `ws` broadcaster | `notification.ts` | DO hub (analysis 05) |
| `child_process.spawn` | `eval-launcher.ts` | none — evals deferred |
| `@huggingface/transformers` / onnx WASM | UI voice only | not part of this layer |

Already portable: `@anthropic-ai/sdk`, `oauth-encryption.ts` (WebCrypto), `openAiEmbed`,
`cohereRerank`, `agent-kit.ts`, all `src/shared/*` contracts, all React UI.

---

## 10. Documentation to carry forward

From `docs/CONCEPTS.md`: §2 (provider model; keep the Anthropic-compatible/`authToken` trap
and the `withRequestDefaults` rationale, drop Moonshot/Fireworks/Bedrock specifics into a
"presets" appendix), §2.0.1 (thinking off by default — keep verbatim, it is the cost argument),
§2.1 (several providers + a model per agent; absence-is-default convention; `resolveFor` per
stage; model shown wherever AI runs), §2.2 (three-outcome connection test, credentials never in
the response), §2.3 (`describeAiError`), §3 first two paragraphs + the "changing the embeddings
model invalidates every vector" warning and the `id` tiebreak note (drop layers, rerank,
reindex), §4 (agents and background work — rewrite the pg-boss mechanics as the Workflows/Queues
mapping but keep "a route never runs an agent; it enqueues one", concurrency as declared
policy, plain jobs vs agents).

From `.claude/rules/api.md`: **Agents** (`:138-161`) — every bullet survives with mechanism
words swapped; **Background work that is NOT an agent** (`:163-201`) — the "plain ≠ untraced"
rule; **Observability** (`:203+`) — "every LLM call must be traced; wrap every new agent entry
point in `withAgentTrace` with a stable name". Also `src/shared/prompts/CLAUDE.md` (adding a
prompt), and the schema `CLAUDE.md` note on appending enum values last.

---

## (a) Proposed file list — kit AI layer

```
src/shared/ai/
  config.ts          providers enum, thinking helpers, aiConfig/upsert/test schemas (from shared/ai-config.ts)
  agent-models.ts    assignment contracts
  agents.ts          AGENT_KEYS, AGENT_META, run status, isRunActive (from shared/agents/run.ts)
  progress.ts        SSE frame schemas (from shared/agent-progress.ts)
  tool-labels.ts
  chat.ts            conversation/message schemas + chat SSE frame schema
  prompts/{registry,defaults,contracts}.ts
src/api/services/ai/
  providers.ts       PROVIDERS catalog (v1 set)
  resolve.ts         resolveClient / resolveModel / readiness / buildClientFromConfig (from ai.ts)
  embeddings.ts      resolveEmbeddingsClient, openAiEmbed, workersAiEmbed
  kit.ts             cachedSystem, breakpoints, callStructuredTool, runToolLoop, runStreamingChat
  errors.ts          describeAiError, redactSecrets
  connection-test.ts
src/api/services/agents/
  runtime.ts  queue.ts (enqueueRun/claim/cancel over Workflows)  run-log.ts  registry.ts
  examples/summarize-text.ts
src/api/services/chat/conversations.ts
src/api/services/prompts.ts
src/api/services/retrieval.ts          searchChunks (cosine + lexical + RRF)
src/api/observability/{tracer.ts (interface + no-op), langfuse-fetch.ts, tracing.ts (withAgentTrace, traceClient)}
src/api/routes/{ai-config,agent-models,prompts,chat,agent-runs}.ts
src/api/utils/routes/agent-progress.ts  streamRunProgress (DO wake)
src/api/workflows/agent-run.ts          Workflow class wrapping runAgent
src/db/schema/{ai-configs,agent-models,prompt-overrides,conversations,messages,agent-runs,agent-run-events,documents,chunks}.ts
src/ui/lib/{sse.ts,agentProgress.ts,chatStream.ts}
src/ui/components/ai/{AgentProgress,AgentTranscript,AgentProgressModal,AgentSteps,ChatBubble,Markdown,ModelBadge}.tsx
src/ui/pages/settings/{AIProvider,AgentModels,Prompts}.tsx
src/ui/pages/{chat/ChatPage.tsx, agents/AgentRuns.tsx}
docs/ai.md  (carried CONCEPTS §2/§4 material)
```

## (b) v1 provider set + config model

Chat: `anthropic`, `anthropic_compatible` (presets: Fireworks, Moonshot). Embeddings:
`workers_ai` (default, binding), `openai`, `openai_compatible`. Config: env defaults
(`ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_TURNS`) →
tenant `ai_configs` (scope × provider, one default per scope, encrypted creds, `serviceTier`,
`thinking`) → `agent_models` (promptKey → config + model). Single read seam
`resolveClient(db, tenantId, env, promptKey?)`.

## (c) Example agent + chat surface

Agent: `summarize-text` (exclusive, precheck, one terminal tool, persists a result, broadcasts),
plus the runs list + progress modal. Chat: persisted `conversations`/`messages`, one SSE route,
`ChatPanel` with markdown bubbles and tool-step strip, zero default tools, prompt key `chat`
editable in Settings → Prompts.

## (d) Observability on Workers

`withAgentTrace` + `traceClient` seams unchanged; backend = GM-style fetch ingestion to
Langfuse, per-request tracer flushed in `waitUntil`, no-op when keys absent. No OTel dependency
in v1; `@microlabs/otel-cf-workers` remains the path if broader tracing is wanted later.

## (e) Defer

Bedrock (chat + Titan), Azure OpenAI, Gemini/OpenAI-shaped chat adapters, rerank + context
layers + reindex UI, structured dry-run, prompt versioning/templating, usage/cost tables and
budgets, evals harness and UI, voice.

## (f) Env vars / bindings

Vars/secrets: `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`, `AGENT_MAX_OUTPUT_TOKENS`,
`AGENT_MAX_TURNS`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
`LANGFUSE_TRACING_ENVIRONMENT`, `OAUTH_ENCRYPTION_KEY` (shared with auth). Bindings: `AI`
(Workers AI), `AGENT_RUN_WORKFLOW` (Workflows), `JOBS_QUEUE` (plain jobs), `NOTIFICATIONS_HUB`
(DO, from analysis 05), `HYPERDRIVE` (from 04). Not carried: GM `AI_PROVIDER`/`AI_MODELS`
(the tenant row supersedes them), `LANGFUSE_ENABLED`, `VECTORIZE_INDEX`.

## (g) Open questions / risks

1. **Agent runs on Workflows vs Queues** — a 30-turn tool loop can outlive a queue consumer;
   Workflows fit but each turn as a `step.do` means the loop body must be step-shaped
   (serializable state between turns). Needs a spike with `runToolLoop`.
2. **Cancellation across isolates** — recommend per-turn status poll (already have
   `signal.aborted` checks) over routing aborts through the DO; confirm with the realtime agent.
3. **Embedding dimension** — 1024 (`bge-large`) vs 768 (`bge-base`); decide before the first
   migration since it is a column type.
4. **SSE duration limits** on Workers for `streamRunProgress` — cap and rely on
   `Last-Event-ID` reconnect (already supported).
5. **`AnthropicBedrock` on `nodejs_compat`** — untested; treat as extension.
6. **Cost tracking** — no table today; if the kit wants per-tenant budgets, add
   `ai_usage (tenantId, promptKey, model, input, output, cacheRead, cacheWrite, at)` written from
   the same `toUsageDetails` tap — cheap now, hard to backfill later.
7. **RLS** — Mirevue's tool handlers depend on `scoped` for post-response DB access; on Neon
   without connection pinning this collapses to `db` with tenant predicates (analysis 01/04
   decision).
