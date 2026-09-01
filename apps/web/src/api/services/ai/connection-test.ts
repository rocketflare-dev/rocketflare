/**
 * "Test connection" (D17): one minimal, deliberately cheap call against a provider — a 10-token
 * completion for chat, one embedding for embeddings — resolved EXACTLY the way the runtime does
 * (`chatClientFromRow` / `embeddingsClientFromRow`), so a green test cannot mean something
 * different from a green chat. Tests either a saved row (`configId`, tenant-scoped) or an inline
 * candidate the admin has not saved yet. Nothing credential-shaped leaves this module: the verdict
 * is built from the normalised `AiError`, never the upstream body.
 */
import type { TestAiConfigRequest, TestAiConfigResponse } from '@gmgo/shared/ai/config'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AiConfigRow, aiConfigs } from '../../../db/schema'
import { BadRequestError, NotFoundError } from '../../utils/core/errors'
import { createChatClient, createEmbeddingsClient, type FetchLike } from './client'
import { AiError, describeAiError, normalizeAiError } from './errors'
import { providerSupportsScope } from './providers'
import { chatClientFromRow, embeddingsClientFromRow } from './resolve'
import type { AiEnv, ChatClient, EmbeddingsClient } from './types'

/** A test that hangs is worse than one that fails — the admin is watching a spinner. */
export const PROBE_TIMEOUT_MS = 20_000
const PROBE_TEXT = 'ping'

interface Candidate {
  scope: 'chat' | 'embeddings'
  provider: AiConfigRow['provider']
  model: string
  chat?: ChatClient
  embeddings?: EmbeddingsClient
}

async function candidateFor(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  input: TestAiConfigRequest,
  fetchImpl?: FetchLike
): Promise<Candidate> {
  if ('configId' in input) {
    const row = await db.query.aiConfigs.findFirst({
      where: and(eq(aiConfigs.id, input.configId), eq(aiConfigs.tenantId, tenantId)),
    })
    if (!row) throw new NotFoundError('AI config not found')
    return row.scope === 'chat'
      ? {
          scope: 'chat',
          provider: row.provider,
          model: row.model,
          chat: await chatClientFromRow(row, cfg, fetchImpl),
        }
      : {
          scope: 'embeddings',
          provider: row.provider,
          model: row.model,
          embeddings: await embeddingsClientFromRow(row, cfg, env, fetchImpl),
        }
  }
  if (!providerSupportsScope(input.provider, input.scope)) {
    throw new BadRequestError(
      `${input.provider} has no ${input.scope} adapter`,
      'provider_scope_unsupported'
    )
  }
  const common = {
    provider: input.provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    fetch: fetchImpl,
  }
  return input.scope === 'chat'
    ? {
        scope: 'chat',
        provider: input.provider,
        model: input.model,
        chat: createChatClient(common),
      }
    : {
        scope: 'embeddings',
        provider: input.provider,
        model: input.model,
        embeddings: createEmbeddingsClient({ ...common, model: input.model, ai: env.AI }),
      }
}

/**
 * Run the probe. Never rejects with a provider failure — that IS the verdict. Only a 404 (unknown
 * config id) or 400 (unsupported scope) escapes, before anything is called.
 */
export async function testConfig(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  input: TestAiConfigRequest,
  options: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<TestAiConfigResponse> {
  let candidate: Candidate
  try {
    candidate = await candidateFor(db, cfg, env, tenantId, input, options.fetch)
  } catch (err) {
    if (err instanceof AiError) {
      const provider = 'configId' in input ? err.provider : input.provider
      const model = 'configId' in input ? '' : input.model
      return {
        ok: false,
        latencyMs: 0,
        model,
        provider,
        error: describeAiError(err),
        code: err.code,
      }
    }
    throw err
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    if (candidate.chat) {
      await candidate.chat.complete({
        model: candidate.model,
        maxTokens: 10,
        messages: [{ role: 'user', content: PROBE_TEXT }],
        cache: false,
        signal: controller.signal,
      })
    } else if (candidate.embeddings) {
      const [vector] = await candidate.embeddings.embed([PROBE_TEXT])
      if (!vector || vector.length !== candidate.embeddings.dimension) {
        throw new AiError(
          'invalid_request',
          candidate.provider,
          `Expected a ${candidate.embeddings.dimension}-dimension vector, got ${vector?.length ?? 0}`
        )
      }
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: candidate.model,
      provider: candidate.provider,
    }
  } catch (err) {
    const normalised = normalizeAiError(err, candidate.provider)
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: candidate.model,
      provider: candidate.provider,
      error: describeAiError(normalised),
      code: normalised.code,
    }
  } finally {
    clearTimeout(timer)
  }
}
