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
} from '@gmgo/shared/ai/config'

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
  /** Chat models worth suggesting in a picker (free text is always allowed). */
  suggestedModels: readonly string[]
}

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
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
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
    suggestedModels: ['accounts/fireworks/models/kimi-k2-instruct', 'kimi-k2-0905-preview'],
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
    suggestedModels: [
      'gpt-4.1-mini',
      'gpt-4.1',
      'text-embedding-3-small',
      'text-embedding-3-large',
    ],
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
    suggestedModels: [],
  },
  {
    id: 'workers_ai',
    name: 'Cloudflare Workers AI',
    scopes: ['embeddings'],
    needsApiKey: false,
    needsBaseUrl: false,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.workers_ai,
    presets: [],
    suggestedModels: ['@cf/baai/bge-m3', '@cf/baai/bge-large-en-v1.5'],
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
