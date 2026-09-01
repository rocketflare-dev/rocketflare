/**
 * The single read seam for "which AI client does this tenant get" (D17). Resolution order:
 *   chat:       tenant default `ai_configs(scope='chat')` → platform `ANTHROPIC_API_KEY` →
 *               `workers_ai` (`WORKERS_AI_CHAT_MODEL`) if `env.AI` → 503
 *   embeddings: tenant default `ai_configs(scope='embeddings')` → `workers_ai` if `env.AI` →
 *               `EMBEDDINGS_API_KEY` (OpenAI) → 503
 * Credentials are decrypted here and nowhere else. `readiness()` mirrors both orders WITHOUT
 * building a client or throwing (the Home checklist must not turn a page load into a 503).
 * Feature code never queries `ai_configs`; the chat route, connection test and Phase 3b agents
 * all come through here — and tests mock this module (`vi.mock('@/api/services/ai/resolve')`).
 *
 * `promptKey` (D17, Phase 3b) consults `agent_models` FIRST: an assignment for `(tenant, promptKey)`
 * names a specific chat config (`aiConfigId`, else the tenant default) and/or a model override; the
 * chain is then assignment → tenant default → platform → 503. Only chat is assignable — embeddings
 * feed a different client shape and no agent runs on them.
 */
import type {
  AiProvider,
  AiReadiness,
  AiScope,
  AiScopeReadiness,
} from '@rocketflare/shared/ai/config'
import { DEFAULT_MODELS, WORKERS_AI_CHAT_MODEL } from '@rocketflare/shared/ai/config'
import type { PromptKey } from '@rocketflare/shared/ai/prompts'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AgentModelRow, type AiConfigRow, agentModels, aiConfigs } from '../../../db/schema'
import { decrypt, requireEncryptionKey } from '../../auth/oauth-encryption'
import { createChatClient, createEmbeddingsClient, type FetchLike } from './client'
import { AiNotConfiguredError } from './errors'
import type { AiEnv, ChatClient, EmbeddingsClient } from './types'

export interface ResolvedChat {
  client: ChatClient
  provider: AiProvider
  model: string
  /** `agent` = an `agent_models` assignment for `promptKey` decided the config and/or model. */
  source: 'tenant' | 'platform' | 'agent'
  /** `cfg.AGENT_MAX_OUTPUT_TOKENS` — the per-call `max_tokens` consumers pass. */
  maxOutputTokens: number
  configId?: string
}

export interface ResolvedEmbeddings {
  client: EmbeddingsClient
  provider: AiProvider
  model: string
  source: 'tenant' | 'platform'
  configId?: string
}

export interface ResolveOptions {
  /** Per-agent config/model lookup keyed on the prompt registry (`agent_models`). Chat only. */
  promptKey?: PromptKey
  /** Injected for tests. */
  fetch?: FetchLike
}

/** The tenant's default row for a scope (the partial unique index guarantees at most one). */
export async function findDefaultConfig(
  db: Database,
  tenantId: string,
  scope: AiScope
): Promise<AiConfigRow | undefined> {
  return db.query.aiConfigs.findFirst({
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, scope),
      eq(aiConfigs.isDefault, true)
    ),
  })
}

/** The `agent_models` assignment for a prompt key, or null (= tenant default). */
export async function findAgentModel(
  db: Database,
  tenantId: string,
  promptKey: PromptKey
): Promise<AgentModelRow | null> {
  const row = await db.query.agentModels.findFirst({
    where: and(eq(agentModels.tenantId, tenantId), eq(agentModels.promptKey, promptKey)),
  })
  return row ?? null
}

/** A tenant's chat config by id — tenant-scoped so a foreign id reads as "not found". */
export async function findChatConfigById(
  db: Database,
  tenantId: string,
  id: string
): Promise<AiConfigRow | undefined> {
  return db.query.aiConfigs.findFirst({
    where: and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.id, id), eq(aiConfigs.scope, 'chat')),
  })
}

/**
 * What `resolveChat` will use for a prompt key, BEFORE building a client: the assignment (if any),
 * the config row it lands on (tenant default when the assignment names none) and the model.
 * `config: undefined` means the platform key is next in line. Shared by `resolveChat` and the
 * agent-models settings list so the two can never disagree.
 */
export async function planChat(
  db: Database,
  tenantId: string,
  promptKey?: PromptKey
): Promise<{ assignment: AgentModelRow | null; config: AiConfigRow | undefined; model?: string }> {
  const assignment = promptKey ? await findAgentModel(db, tenantId, promptKey) : null
  const config = assignment?.aiConfigId
    ? await findChatConfigById(db, tenantId, assignment.aiConfigId)
    : await findDefaultConfig(db, tenantId, 'chat')
  return { assignment, config, model: assignment?.model ?? undefined }
}

/** Decrypt a row's credential (null for key-less providers). The ONLY place `apiKeyEnc` is read. */
export async function credentialOf(
  row: Pick<AiConfigRow, 'apiKeyEnc'>,
  cfg: AppConfig
): Promise<string | null> {
  if (!row.apiKeyEnc) return null
  return decrypt(row.apiKeyEnc, requireEncryptionKey(cfg))
}

/** Build a chat client from ONE config row — exported for the connection test, which probes a named row. */
export async function chatClientFromRow(
  row: AiConfigRow,
  cfg: AppConfig,
  env: AiEnv,
  fetchImpl?: FetchLike
): Promise<ChatClient> {
  return createChatClient({
    provider: row.provider,
    apiKey: await credentialOf(row, cfg),
    baseUrl: row.baseUrl,
    defaults: { serviceTier: row.serviceTier, thinking: row.thinking },
    ai: env.AI,
    fetch: fetchImpl,
  })
}

/** The platform chat tier that answers when a tenant has no chat row, or null when none exists. */
export interface PlatformChat {
  provider: AiProvider
  model: string
  build: (fetchImpl?: FetchLike) => ChatClient
}

/**
 * Platform order: the operator's `ANTHROPIC_API_KEY` (a deliberate choice) → the `AI` binding
 * (zero key, billed to the Cloudflare account) → nothing. The ONE definition `resolveChat`,
 * `readiness` and the agent-models list all read, so the three can never disagree.
 */
export function platformChat(cfg: AppConfig, env: AiEnv): PlatformChat | null {
  if (cfg.ANTHROPIC_API_KEY) {
    const apiKey = cfg.ANTHROPIC_API_KEY
    return {
      provider: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
      build: fetchImpl => createChatClient({ provider: 'anthropic', apiKey, fetch: fetchImpl }),
    }
  }
  if (env.AI) {
    const ai = env.AI
    return {
      provider: 'workers_ai',
      model: WORKERS_AI_CHAT_MODEL,
      build: () => createChatClient({ provider: 'workers_ai', ai }),
    }
  }
  return null
}

export async function embeddingsClientFromRow(
  row: AiConfigRow,
  cfg: AppConfig,
  env: AiEnv,
  fetchImpl?: FetchLike
): Promise<EmbeddingsClient> {
  return createEmbeddingsClient({
    provider: row.provider,
    model: row.model,
    apiKey: await credentialOf(row, cfg),
    baseUrl: row.baseUrl,
    ai: env.AI,
    fetch: fetchImpl,
  })
}

export async function resolveChat(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  options: ResolveOptions = {}
): Promise<ResolvedChat> {
  const {
    assignment,
    config: row,
    model: override,
  } = await planChat(db, tenantId, options.promptKey)
  const source = assignment ? 'agent' : 'tenant'
  if (row) {
    return {
      client: await chatClientFromRow(row, cfg, env, options.fetch),
      provider: row.provider,
      model: override ?? row.model,
      source,
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
      configId: row.id,
    }
  }
  const platform = platformChat(cfg, env)
  if (platform) {
    return {
      client: platform.build(options.fetch),
      provider: platform.provider,
      model: override ?? platform.model,
      source: assignment ? 'agent' : 'platform',
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
    }
  }
  throw new AiNotConfiguredError('chat')
}

export async function resolveEmbeddings(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  options: ResolveOptions = {}
): Promise<ResolvedEmbeddings> {
  const row = await findDefaultConfig(db, tenantId, 'embeddings')
  if (row) {
    return {
      client: await embeddingsClientFromRow(row, cfg, env, options.fetch),
      provider: row.provider,
      model: row.model,
      source: 'tenant',
      configId: row.id,
    }
  }
  if (env.AI) {
    const model = DEFAULT_MODELS.workers_ai
    return {
      client: createEmbeddingsClient({ provider: 'workers_ai', model, ai: env.AI }),
      provider: 'workers_ai',
      model,
      source: 'platform',
    }
  }
  if (cfg.EMBEDDINGS_API_KEY) {
    const model = DEFAULT_MODELS.openai
    return {
      client: createEmbeddingsClient({
        provider: 'openai',
        model,
        apiKey: cfg.EMBEDDINGS_API_KEY,
        fetch: options.fetch,
      }),
      provider: 'openai',
      model,
      source: 'platform',
    }
  }
  throw new AiNotConfiguredError('embeddings')
}

/** What the two resolvers WOULD pick — no client is built, no credential decrypted, nothing thrown. */
export async function readiness(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string
): Promise<AiReadiness> {
  const [chatRow, embRow] = await Promise.all([
    findDefaultConfig(db, tenantId, 'chat'),
    findDefaultConfig(db, tenantId, 'embeddings'),
  ])
  const none: AiScopeReadiness = { ready: false, source: 'none' }
  const platform = platformChat(cfg, env)
  const chat: AiScopeReadiness = chatRow
    ? { ready: true, source: 'tenant', provider: chatRow.provider, model: chatRow.model }
    : platform
      ? { ready: true, source: 'platform', provider: platform.provider, model: platform.model }
      : none
  const embeddings: AiScopeReadiness = embRow
    ? { ready: true, source: 'tenant', provider: embRow.provider, model: embRow.model }
    : env.AI
      ? {
          ready: true,
          source: 'platform',
          provider: 'workers_ai',
          model: DEFAULT_MODELS.workers_ai,
        }
      : cfg.EMBEDDINGS_API_KEY
        ? { ready: true, source: 'platform', provider: 'openai', model: DEFAULT_MODELS.openai }
        : none
  return { chat, embeddings }
}
