/**
 * Which provider a target or the judge runs on. `anthropic` is the platform tier — the
 * `ANTHROPIC_API_KEY` the resolver already falls back to, no row needed. Every other provider is a
 * REAL tenant `ai_configs` row, written the way Settings → AI writes one (key encrypted with
 * `OAUTH_ENCRYPTION_KEY`, `isDefault: true`), so an eval on Fireworks or Gemini also exercises the
 * tenant-config tier of the resolver rather than a side door.
 *
 * Fireworks is the built-in `fireworks` preset (`anthropic_compatible`); Gemini is
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
    // The built-in Fireworks preset, so an eval proves what Settings → AI would offer a tenant.
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

/**
 * The rerankers `--rerank` can name. `fireworks` is the kit's own `fireworks-rerank` preset
 * (`openai_compatible`, a Cohere-style `POST {base}/rerank`), on `fireworks/qwen3-reranker-8b`.
 * `workers-ai` is a `workers_ai` row on `@cf/baai/bge-reranker-base`: the Worker's `AI` binding,
 * which in an eval is Workers AI's REST API on CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 * (`workersAiRestBinding` in `env.ts`) — the stub's scores would measure nothing.
 */
const fireworksRerank = PROVIDER_PRESETS.find(p => p.id === 'fireworks-rerank')

export const EVAL_RERANKERS = {
  none: null,
  fireworks: {
    keyEnv: 'FIREWORKS_API_KEY',
    provider: 'openai_compatible',
    baseUrl: fireworksRerank?.baseUrl ?? 'https://api.fireworks.ai/inference/v1',
    model: fireworksRerank?.defaultModel ?? 'fireworks/qwen3-reranker-8b',
  },
  'workers-ai': {
    keyEnv: null,
    provider: 'workers_ai',
    baseUrl: null,
    model: '@cf/baai/bge-reranker-base',
  },
} as const satisfies Record<
  string,
  { keyEnv: string | null; provider: AiProvider; baseUrl: string | null; model: string } | null
>

export type EvalRerankerName = keyof typeof EVAL_RERANKERS

export function evalReranker(name: string | undefined): EvalRerankerName {
  const key = (name || 'none') as EvalRerankerName
  if (!(key in EVAL_RERANKERS)) {
    throw new Error(
      `unknown eval reranker "${name}" — one of ${Object.keys(EVAL_RERANKERS).join(', ')}`
    )
  }
  return key
}

/**
 * Give a tenant the reranker `--rerank` named: a default `rerank` `ai_configs` row, written the way
 * Settings → AI writes one, so the eval exercises `resolveRerank`'s tenant tier. `none` writes
 * nothing (the retrieval target then searches with `rerank: false`).
 */
export async function useRerank(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  name: EvalRerankerName
): Promise<void> {
  const reranker = EVAL_RERANKERS[name]
  if (!reranker) return
  const apiKey = reranker.keyEnv ? process.env[reranker.keyEnv] : null
  if (reranker.keyEnv && !apiKey)
    throw new Error(`${reranker.keyEnv} is not set (--rerank ${name})`)
  await db.insert(aiConfigs).values({
    tenantId,
    scope: 'rerank',
    provider: reranker.provider,
    label: `eval · ${name} rerank`,
    baseUrl: reranker.baseUrl,
    model: reranker.model,
    apiKeyEnc: apiKey ? await encrypt(apiKey, requireEncryptionKey(cfg)) : null,
    isDefault: true,
  })
}

/**
 * Which REAL embedder a corpus is ingested with. Corpus suites refuse the test stub's deterministic
 * vectors — a ranking measured on them says nothing about the one production serves. Order:
 * `EMBEDDINGS_API_KEY` (the platform OpenAI tier, no row), then `GEMINI_API_KEY` as a tenant
 * `openai_compatible` embeddings row on `gemini-embedding-001` at the kit's 1024 dimensions —
 * the tenant tier, exactly as Settings → AI would write it. Null = no real embedder: corpus suites
 * skip and say so.
 */
export function evalEmbeddings(): { name: string; keyEnv: string; row: boolean } | null {
  if (process.env.EMBEDDINGS_API_KEY) {
    return { name: 'openai text-embedding-3-small', keyEnv: 'EMBEDDINGS_API_KEY', row: false }
  }
  if (process.env.GEMINI_API_KEY) {
    return { name: 'gemini-embedding-001', keyEnv: 'GEMINI_API_KEY', row: true }
  }
  return null
}

/** Give a tenant the real embedder `evalEmbeddings()` picked (a row only for the Gemini tier). */
export async function useEmbeddings(db: Database, cfg: AppConfig, tenantId: string): Promise<void> {
  const choice = evalEmbeddings()
  if (!choice)
    throw new Error('no real embeddings provider: set EMBEDDINGS_API_KEY or GEMINI_API_KEY')
  if (!choice.row) return
  await db.insert(aiConfigs).values({
    tenantId,
    scope: 'embeddings',
    provider: 'openai_compatible',
    label: 'eval · gemini embeddings',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-embedding-001',
    apiKeyEnc: await encrypt(process.env.GEMINI_API_KEY as string, requireEncryptionKey(cfg)),
    isDefault: true,
  })
}
