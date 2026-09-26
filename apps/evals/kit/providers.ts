/**
 * Which provider a target or the judge runs on (D33). `anthropic` is the platform tier — the
 * `ANTHROPIC_API_KEY` the resolver already falls back to, no row needed. Every other provider is a
 * REAL tenant `ai_configs` row, written the way Settings → AI writes one (key encrypted with
 * `OAUTH_ENCRYPTION_KEY`, `isDefault: true`), so an eval on Fireworks or Gemini also exercises the
 * tenant-config tier of the resolver rather than a side door.
 *
 * Fireworks is the kit's own `fireworks` preset (`anthropic_compatible`); Gemini is
 * `openai_compatible` against Google's OpenAI-compatible endpoint (the client appends
 * `/chat/completions`).
 */
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { PROVIDER_PRESETS } from '@rocketflare/shared/ai/config'
import { encrypt, requireEncryptionKey } from '@/api/auth/oauth-encryption'
import type { AppConfig } from '@/config'
import type { Database } from '@/db/client'
import { aiConfigs } from '@/db/schema'

export interface EvalProvider {
  /** The env var holding its key (`apps/web/.dev.vars` or the environment). */
  keyEnv: string
  /** Absent → the platform tier (`platformChat`), no `ai_configs` row. */
  config?: { provider: AiProvider; baseUrl: string; defaultModel: string }
}

const fireworks = PROVIDER_PRESETS.find(p => p.id === 'fireworks')

export const EVAL_PROVIDERS = {
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY' },
  fireworks: {
    keyEnv: 'FIREWORKS_API_KEY',
    // The kit's own Fireworks preset, so an eval proves what Settings → AI would offer a tenant.
    config: {
      provider: 'anthropic_compatible',
      baseUrl: fireworks?.baseUrl ?? 'https://api.fireworks.ai/inference',
      defaultModel: fireworks?.defaultModel ?? 'accounts/fireworks/models/gpt-oss-120b',
    },
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    config: {
      provider: 'openai_compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-flash',
    },
  },
} as const satisfies Record<string, EvalProvider>

export type EvalProviderName = keyof typeof EVAL_PROVIDERS

export function evalProvider(name: string | undefined): EvalProvider & { name: EvalProviderName } {
  const key = (name || 'anthropic') as EvalProviderName
  const provider: EvalProvider | undefined = EVAL_PROVIDERS[key]
  if (!provider) {
    throw new Error(
      `unknown eval provider "${name}" — one of ${Object.keys(EVAL_PROVIDERS).join(', ')}`
    )
  }
  return { ...provider, name: key }
}

/** Point a tenant at a provider: a default chat `ai_configs` row, or nothing for the platform tier. */
export async function useProvider(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  provider: EvalProvider & { name: EvalProviderName },
  model: string | undefined
): Promise<void> {
  if (!provider.config) return
  const apiKey = process.env[provider.keyEnv]
  if (!apiKey) throw new Error(`${provider.keyEnv} is not set`)
  await db.insert(aiConfigs).values({
    tenantId,
    scope: 'chat',
    provider: provider.config.provider,
    label: `eval · ${provider.name}`,
    baseUrl: provider.config.baseUrl,
    model: model ?? provider.config.defaultModel,
    apiKeyEnc: await encrypt(apiKey, requireEncryptionKey(cfg)),
    isDefault: true,
  })
}
