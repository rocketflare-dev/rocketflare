# AI services (D16, D17, D18)

The provider seam and everything that calls a model. Feature code (routes, agents) never imports an
SDK, never reads `ai_configs`, never decrypts a key — it asks `resolve.ts` for a client and calls it
through `kit.ts`.

| File | Role |
|---|---|
| `types.ts` | `ChatClient { stream, complete, countTokens? }`, `EmbeddingsClient { embed, dimension }`, block-shaped `ChatMessage`/`ContentBlock`, `SystemPrompt` (`string \| { stable, volatile }`), `ChatDelta`, `RequestDefaults`, `AiEnv` (`{ AI? }`) |
| `providers.ts` | `PROVIDERS` catalog — DATA only: `scopes` (an adapter exists), `needsApiKey/BaseUrl`, `supportsThinking/ServiceTier`, presets, suggested models |
| `client.ts` | Adapters: `createChatClient` (`anthropic` / `anthropic_compatible` via `@anthropic-ai/sdk`; `openai` / `openai_compatible` via fetch SSE; `workers_ai` via `env.AI.run` — OpenAI-shaped inputs, no `tool_choice` so a forced tool is `forcedToolInstruction` in the system prompt + `recoverForcedToolCall` when the model writes the arguments as a JSON object in prose, and `stream()` with tools is one non-streamed call replayed as deltas), `createEmbeddingsClient` (`openai*` `/embeddings`, `workers_ai` binding). Injects `service_tier` + `thinking` (explicitly `disabled` by default), `reconcileThinking`. `fetch` is injectable |
| `client.ts` (workers_ai) | `env.AI.run` cannot be aborted → every call is raced against `WORKERS_AI_TIMEOUT_MS` (120 s) into a retryable `unavailable` `AiError`. Per-model schemas differ: null content is never sent, and a schema rejection (`5006`/`oneOf`, `isWorkersAiSchemaError`) retries ONCE with `flattenWorkersAiMessages` (system/user/assistant, string content, tool call + result as text) |
| `resolve.ts` | `resolveChat` / `resolveEmbeddings` / `readiness` — tenant default row → `platformChat(cfg, env)` (`ANTHROPIC_API_KEY` → `workers_ai` + `WORKERS_AI_CHAT_MODEL` when `env.AI`) → `AiNotConfiguredError` (503 `ai_not_configured`). The ONLY reader of `ai_configs` and the ONLY decrypt. Tests `vi.mock` this module |
| `kit.ts` | `cachedSystem`, `withRollingCacheBreakpoints`, `Tool` (zod schema + optional handler; no handler = terminal), `callStructuredTool` (forced tool, 1 retry; `StructuredOutputError.issues` = the zod issues or `{ reason, stopReason, text }` when there was no call), `runToolLoop` (Phase 3b engine), `runStreamingChat` (chat engine) |
| `errors.ts` | `AiError { code: auth \| rate_limit \| invalid_request \| unavailable \| unknown }`, `normalizeAiError`, `describeAiError`, `redactSecrets`, `AiNotConfiguredError` |
| `usage.ts` | `recordUsage` → `ai_usage` (cost frozen from `@rocketflare/shared/ai/pricing` unless the caller passes one), `tapUsage(client, cb)`, `summarizeUsage` (prices rows with no stored cost from the same table; `unpricedCalls` counts what has no price at all) |
| `connection-test.ts` | `testConfig` — 10-token completion / one embedding, same builders as the resolver, never throws a provider error |
| `deterministic-embedding.ts` | `deterministicEmbedding` (hashed bag of words, `EMBEDDING_DIM` wide, L2-normalised, never zero) + `DETERMINISTIC_EMBEDDING_MODEL = 'seed:deterministic'` — for `pnpm seed --demo` and the test `RecordingAi` stub ONLY; nothing on the request path imports it, so the Worker bundle never carries it (`grep -rn deterministic-embedding apps/web/src` must list only this file) |

Rules:

- **Resolve before you stream.** A route calls `resolveChat` (and anything else that can 4xx/5xx)
  BEFORE `streamSSE`, so a missing provider is a JSON 503, not a broken stream.
- **Per-tenant request defaults live in the adapter**, never at call sites. Thinking is OFF unless
  a config turns it on; `reconcileThinking` drops it on forced tool choice and lifts `max_tokens`.
- **Wrap, don't fork.** Tracing (`observability/tracing.ts` `traceChatClient`) and usage
  (`tapUsage`) are client wrappers; a new cross-cutting concern is another wrapper.
- **Credentials never leave the server.** Routes answer `hasCredential`; errors pass `redactSecrets`.
- **A streaming route needs its own DB client** (`streamDatabase(c)` in `utils/routes/route-helpers.ts`):
  the request's client is closed in `waitUntil` the moment the Response is returned.
- Adding a provider: enum value in `@rocketflare/shared/ai/config` (append last) → `PROVIDERS` entry →
  adapter branch in `client.ts` → `ai-client.test.ts` case. Adding a prompt: `PROMPT_REGISTRY` in
  `../prompts.ts` (no migration). Per-agent model assignment (`agent_models`, Phase 3b — built) is
  `resolveChat`'s `promptKey` branch (`planChat` — shared with `routes/ai-agent-models.ts`).
- `chunking.ts` (pure paragraph-aware chunker, ~800 tokens / 100 overlap, 4 chars per token),
  `ingest.ts` (`ingestText` and `ingestFile` — inline ≤ 50 chunks else the `document.index` job, or
  `document.convert` for a binary upload; `indexDocument` is shared with
  `queues/handlers/document-index.ts`, `convertAndIndexDocument` with `document-convert.ts`),
  `convert.ts` (`needsConversion` / `canConvert` / `decodeText` / `convertToText` over
  `env.AI.toMarkdown`; `ConversionFailedError` is the permanent case), `retrieval.ts` (`searchChunks` — dense `<=>` +
  lexical `ts_rank_cd`, RRF `k = 60`; `RerankFn` is the documented, unbuilt seam) complete the D18 half.
