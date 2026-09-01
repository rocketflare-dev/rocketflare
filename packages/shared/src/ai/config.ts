/**
 * Tenant AI configuration contracts (D17): the provider enum, the sanitised `ai_configs` row the
 * API returns (`hasCredential`, never the key), the write-only upsert body, the connection test
 * and the readiness summary the Home checklist / settings page render. `PROVIDER_PRESETS` and
 * `DEFAULT_MODELS` are data both the settings form and `services/ai/providers.ts` read, so the
 * form cannot offer a base URL or default model the server does not know.
 */
import { z } from 'zod'

/**
 * v1 provider set. `anthropic_compatible` = Anthropic wire format behind a bearer token
 * (Fireworks, Moonshot presets); `openai_compatible` = `/v1/chat/completions` + `/v1/embeddings`
 * behind a bearer token (any vLLM/Ollama/proxy). `workers_ai` is the zero-key binding — embeddings
 * AND chat, the floor every workspace can fall back to.
 * Append values LAST — a Postgres enum cannot use a value in the migration that adds it.
 */
export const AI_PROVIDERS = [
  'anthropic',
  'anthropic_compatible',
  'openai',
  'openai_compatible',
  'workers_ai',
] as const
export const aiProviderSchema = z.enum(AI_PROVIDERS)
export type AiProvider = z.infer<typeof aiProviderSchema>

/** Which client a config feeds: the chat/completion client or the embeddings client. */
export const AI_SCOPES = ['chat', 'embeddings'] as const
export const aiScopeSchema = z.enum(AI_SCOPES)
export type AiScope = z.infer<typeof aiScopeSchema>

/** Provider floor for `thinking.budget_tokens`; below it the vendor answers 400. */
export const THINKING_MIN_BUDGET = 1024
export const THINKING_MAX_BUDGET = 32_000
/** Output room that must remain ABOVE the thinking budget, or every reply truncates to nothing. */
export const THINKING_ANSWER_HEADROOM = 512

/**
 * Extended thinking, per chat config. OFF by default and sent explicitly (`{type:'disabled'}`) on
 * providers that accept the param: a reasoning model left to its own devices bills for thinking
 * the chat surface then discards. Turning it on is an operator's deliberate cost decision.
 */
export const thinkingSchema = z.object({
  enabled: z.boolean(),
  budgetTokens: z.number().int().min(THINKING_MIN_BUDGET).max(THINKING_MAX_BUDGET).optional(),
})
export type ThinkingSetting = z.infer<typeof thinkingSchema>
export const THINKING_DISABLED: ThinkingSetting = { enabled: false }

/**
 * Provider service tier, sent verbatim as `service_tier`. Free text because the vocabulary is
 * per-provider (Anthropic `auto|standard_only`, Fireworks `default|flex|priority`); null = omit
 * the field and let the provider decide.
 */
export const serviceTierSchema = z.string().min(1).max(32)

/** Sanitised config row — credentials NEVER leave the server, only `hasCredential`. */
export const aiConfigSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  scope: aiScopeSchema,
  provider: aiProviderSchema,
  /** Human label, unique per (tenant, scope); the upsert key. */
  label: z.string(),
  baseUrl: z.string().nullable(),
  model: z.string(),
  /** The row every consumer in this scope resolves to; exactly one per (tenant, scope). */
  isDefault: z.boolean(),
  hasCredential: z.boolean(),
  thinking: thinkingSchema,
  serviceTier: serviceTierSchema.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AiConfig = z.infer<typeof aiConfigSchema>

export const aiConfigListResponseSchema = z.object({ items: z.array(aiConfigSchema) })
export type AiConfigListResponse = z.infer<typeof aiConfigListResponseSchema>

/**
 * `POST /api/ai/config` — upsert on (tenant, scope, label). `apiKey` is write-only: omitted on
 * a re-save keeps the stored credential; present replaces it. `isDefault: true` makes this row the
 * scope's default (the previous default is cleared in the same transaction); the first row in a
 * scope is always made default.
 */
export const upsertAiConfigRequestSchema = z.object({
  scope: aiScopeSchema.default('chat'),
  label: z.string().trim().min(1).max(80),
  provider: aiProviderSchema,
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().trim().min(1).max(255),
  apiKey: z.string().min(1).max(4000).optional(),
  isDefault: z.boolean().optional(),
  thinking: thinkingSchema.optional(),
  /** Empty string clears the tier (a `<select>` needs a way to say "none"). */
  serviceTier: z.union([serviceTierSchema, z.literal('')]).optional(),
})
export type UpsertAiConfigRequest = z.infer<typeof upsertAiConfigRequestSchema>

/**
 * `POST /api/ai/config/test` — either a saved row (`configId`) or an inline candidate the admin
 * has not saved yet (so a wrong key is caught while they are still looking at the field).
 */
export const testAiConfigRequestSchema = z.union([
  z.object({ configId: z.string().uuid() }),
  z.object({
    scope: aiScopeSchema.default('chat'),
    provider: aiProviderSchema,
    baseUrl: z.string().url().max(500).optional(),
    model: z.string().trim().min(1).max(255),
    apiKey: z.string().min(1).max(4000).optional(),
  }),
])
export type TestAiConfigRequest = z.infer<typeof testAiConfigRequestSchema>

/** `error` is a normalised sentence from the failure's STATUS — never the upstream body. */
export const testAiConfigResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string(),
  provider: aiProviderSchema,
  error: z.string().optional(),
  /** `auth | rate_limit | invalid_request | unavailable | unknown` when `ok` is false. */
  code: z.string().optional(),
})
export type TestAiConfigResponse = z.infer<typeof testAiConfigResponseSchema>

export const aiReadinessSourceSchema = z.enum(['tenant', 'platform', 'none'])
export type AiReadinessSource = z.infer<typeof aiReadinessSourceSchema>

export const aiScopeReadinessSchema = z.object({
  ready: z.boolean(),
  source: aiReadinessSourceSchema,
  provider: aiProviderSchema.optional(),
  model: z.string().optional(),
})
export type AiScopeReadiness = z.infer<typeof aiScopeReadinessSchema>

/** `GET /api/ai/config/readiness` — what `resolveChat` / `resolveEmbeddings` WOULD pick, no 503. */
export const aiReadinessSchema = z.object({
  chat: aiScopeReadinessSchema,
  embeddings: aiScopeReadinessSchema,
})
export type AiReadiness = z.infer<typeof aiReadinessSchema>

/** Default model per provider — what a new config lands on and what the platform fallback uses. */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  anthropic_compatible: 'accounts/fireworks/models/kimi-k2-instruct',
  openai: 'text-embedding-3-small',
  openai_compatible: '',
  workers_ai: '@cf/baai/bge-m3',
}

/**
 * The zero-key chat floor: Workers AI's Mistral Small 3.1 — function calling, `messages` input,
 * 128k context, Apache-2.0, mid-priced. `resolveChat` lands here when no tenant row and no
 * platform key exist, so a fresh workspace can chat with nothing configured.
 */
export const WORKERS_AI_CHAT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'

/** Chat defaults for providers whose `DEFAULT_MODELS` entry is an embeddings model. */
export const DEFAULT_CHAT_MODELS: Partial<Record<AiProvider, string>> = {
  openai: 'gpt-4.1-mini',
  workers_ai: WORKERS_AI_CHAT_MODEL,
}

/** What a new config for `(provider, scope)` lands on — `DEFAULT_MODELS` is per provider, not per scope. */
export const defaultModelFor = (provider: AiProvider, scope: AiScope): string =>
  (scope === 'chat' ? DEFAULT_CHAT_MODELS[provider] : undefined) ?? DEFAULT_MODELS[provider]

/** Embedding dimension every provider is reduced to (D18); `bge-m3` is natively 1024. */
export const EMBEDDING_DIM = 1024

export interface ProviderPreset {
  id: string
  name: string
  provider: AiProvider
  baseUrl: string
  /** Model the preset lands on; `*_compatible` providers accept any id the endpoint serves. */
  defaultModel: string
  /** Anthropic-compatible vendors that spend output tokens reasoning unless `thinking` is disabled. */
  note?: string
}

/**
 * Known endpoints for the `*_compatible` providers. Presets are data, not enum values, so adding
 * a vendor is one entry here and no migration. Fireworks' URL carries no `/v1` (the Anthropic SDK
 * appends `/v1/messages`); OpenAI-compatible base URLs INCLUDE `/v1`.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    provider: 'anthropic_compatible',
    baseUrl: 'https://api.fireworks.ai/inference',
    defaultModel: 'accounts/fireworks/models/kimi-k2-instruct',
    note: 'Model ids are fully qualified: accounts/<account>/models/<name>.',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    provider: 'anthropic_compatible',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2-0905-preview',
    note: 'China region: https://api.moonshot.cn/anthropic',
  },
  {
    id: 'openai_compatible',
    name: 'OpenAI-compatible (generic)',
    provider: 'openai_compatible',
    baseUrl: '',
    defaultModel: '',
    note: 'Any /v1/chat/completions + /v1/embeddings endpoint (vLLM, Ollama, a proxy). Include /v1.',
  },
]

export const presetsFor = (provider: AiProvider): ProviderPreset[] =>
  PROVIDER_PRESETS.filter(p => p.provider === provider)

/** Display form of a model id: the last path segment (Fireworks ids are long paths). */
export const shortModelName = (model: string): string => model.split('/').pop() || model
