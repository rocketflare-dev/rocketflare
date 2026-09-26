/**
 * Provider catalog (D17) — DATA only, no SDK imports. What each provider can do, what a config row
 * for it must carry, and its presets. `scopes` is the "an adapter exists" gate: a provider is only
 * offered for a scope `client.ts` can build a client for, so a saveable-but-unusable row can never
 * be created. Read by `routes/ai-config.ts` (validation) and served to the settings form.
 */
import {
  type AiProvider,
  type AiScope,
  DEFAULT_MODELS,
  type ProviderPreset,
  presetsFor,
  WORKERS_AI_CHAT_MODEL,
} from '@rocketflare/shared/ai/config'

export interface ProviderInfo {
  id: AiProvider
  name: string
  /** Scopes an adapter exists for. */
  scopes: readonly AiScope[]
  needsApiKey: boolean
  needsBaseUrl: boolean
  /** Accepts Anthropic's `thinking` body param. */
  supportsThinking: boolean
  /** Accepts `service_tier`. */
  supportsServiceTier: boolean
  defaultModel: string
  presets: readonly ProviderPreset[]
  /**
   * Models offered in the picker, BY SCOPE. Keyed by scope because a flat list offers an embeddings
   * model on a chat config and vice versa, which reads as a bug the first time someone picks one.
   */
  suggestedModels: Readonly<Record<AiScope, readonly string[]>>
  /**
   * `true` when the list above IS the catalog, so the form offers those ids and no free text
   * (Workers AI). Everywhere else a model id is whatever the endpoint calls it, so the picker keeps
   * an "other" escape. It is a form affordance, never a validation rule: a stored row naming a
   * model that has since left the list is still shown and still saveable, because the alternative
   * is a config silently rewritten to a model its owner did not choose.
   */
  modelsFixed?: boolean
}

/**
 * Every Workers AI text-generation model that declares BOTH `function_calling` (catalog property)
 * and `tool_choice` (input schema), cheapest first.
 *
 * **One list, three jobs**: the models the settings picker offers for a Workers AI chat config, the
 * models `client.ts` may send a real `tool_choice` to (`workersAiSupportsToolChoice`), and the
 * models it may stream tools to (`workersAiStreamsTools`). They are the same set deliberately — a
 * model without `tool_choice` falls back to asking in the prompt and unwrapping prose JSON, which
 * is a failure mode rather than a choice worth offering. Separate lists would be separate things to
 * keep in step, and the day they disagreed the picker would recommend a model the runtime cannot
 * constrain.
 *
 * A model absent from it is still usable: a stored config naming one works, stays editable and
 * stays priced. The picker is an affordance, never a validation rule.
 *
 * Hand-kept, because nothing here may depend on a network call. To re-derive: take
 * `wrangler ai models list --json` filtered on the `function_calling` property, keep those whose
 * `wrangler ai models schema <model>` declares `tool_choice` under `input.oneOf[].properties`,
 * drive each through a two-turn tool loop to confirm it streams (nothing documents the stream
 * shape), and price it in `@rocketflare/shared/ai/pricing` from the catalog's own `price` property
 * — an unpriced model shows on the Usage page as an `unpricedCall`.
 */
export const WORKERS_AI_TOOL_CHOICE_MODELS = [
  WORKERS_AI_CHAT_MODEL,
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/qwen/qwen3.8-27b',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
] as const

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: false,
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: DEFAULT_MODELS.anthropic,
    presets: [],
    suggestedModels: {
      chat: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
      embeddings: [],
    },
  },
  {
    id: 'anthropic_compatible',
    name: 'Anthropic-compatible (Fireworks, Moonshot, …)',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: true,
    // Fireworks' GLM/Kimi models reason unless told not to — the disabled default is real money.
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: DEFAULT_MODELS.anthropic_compatible,
    presets: presetsFor('anthropic_compatible'),
    suggestedModels: {
      chat: [
        'accounts/fireworks/models/gpt-oss-120b',
        'accounts/fireworks/models/kimi-k2p5',
        'kimi-k2-0905-preview',
      ],
      embeddings: [],
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    scopes: ['chat', 'embeddings'],
    needsApiKey: true,
    needsBaseUrl: false,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.openai,
    presets: [],
    suggestedModels: {
      chat: ['gpt-4.1-mini', 'gpt-4.1'],
      embeddings: ['text-embedding-3-small', 'text-embedding-3-large'],
    },
  },
  {
    id: 'openai_compatible',
    name: 'OpenAI-compatible endpoint',
    scopes: ['chat', 'embeddings'],
    needsApiKey: true,
    needsBaseUrl: true,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.openai_compatible,
    presets: presetsFor('openai_compatible'),
    suggestedModels: { chat: [], embeddings: [] },
  },
  {
    id: 'workers_ai',
    name: 'Cloudflare Workers AI',
    scopes: ['chat', 'embeddings'],
    needsApiKey: false,
    needsBaseUrl: false,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.workers_ai,
    presets: [],
    // Workers AI ids are a closed catalog, so the picker offers the list and nothing else — unlike
    // a vendor endpoint, there is no "the id my account was given" case to leave room for.
    modelsFixed: true,
    suggestedModels: {
      // The capability list IS the picker list — see WORKERS_AI_TOOL_CHOICE_MODELS above.
      chat: WORKERS_AI_TOOL_CHOICE_MODELS,
      embeddings: ['@cf/baai/bge-m3', '@cf/baai/bge-large-en-v1.5'],
    },
  },
]

export function providerInfo(id: AiProvider): ProviderInfo {
  const info = PROVIDERS.find(p => p.id === id)
  if (!info) throw new Error(`Unknown AI provider: ${id}`)
  return info
}

export const providersForScope = (scope: AiScope): ProviderInfo[] =>
  PROVIDERS.filter(p => p.scopes.includes(scope))

export const providerSupportsScope = (id: AiProvider, scope: AiScope): boolean =>
  providerInfo(id).scopes.includes(scope)

/** Default endpoint for providers that have one; `*_compatible` rows must carry their own. */
export const DEFAULT_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: 'https://api.openai.com/v1',
}
