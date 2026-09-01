/**
 * `/api/ai/agent-models` (D17): per-agent model assignment. `GET /` lists EVERY registry prompt
 * key with its assignment (if any) and what `resolveChat` would pick for it — computed by the same
 * `planChat` the resolver uses, so the page can never disagree with the runtime. `PUT /:promptKey`
 * pins a chat config (tenant-scoped — a foreign id is 404) and/or a model; `DELETE` reverts to the
 * default (idempotent). `manage AiConfig` = admin+; members may read.
 */
import {
  type AgentModelAssignment,
  type AgentModelEntry,
  upsertAgentModelRequestSchema,
} from '@rocketflare/shared/ai/agent-models'
import { DEFAULT_MODELS } from '@rocketflare/shared/ai/config'
import { and, eq } from 'drizzle-orm'
import { type AgentModelRow, agentModels } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { findChatConfigById, planChat } from '../services/ai/resolve'
import {
  isPromptKey,
  PROMPT_KEYS,
  PROMPT_REGISTRY,
  type RegistryPromptKey,
} from '../services/prompts'
import type { AppContext } from '../types'
import { NotFoundError } from '../utils/core/errors'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiAgentModelsRouter = createRouter()

function keyParam(c: AppContext): RegistryPromptKey {
  const key = c.req.param('promptKey') ?? ''
  if (!isPromptKey(key)) throw new NotFoundError(`Unknown prompt: ${key}`, 'prompt_not_found')
  return key
}

export function toAssignment(row: AgentModelRow): AgentModelAssignment {
  return {
    promptKey: row.promptKey,
    aiConfigId: row.aiConfigId,
    model: row.model,
    updatedAt: row.updatedAt,
  }
}

aiAgentModelsRouter.get('/', async c => {
  const { db, tenantId, cfg } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  const items: AgentModelEntry[] = []
  for (const key of PROMPT_KEYS) {
    const { assignment, config, model } = await planChat(db, tenantId, key)
    items.push({
      promptKey: key,
      title: PROMPT_REGISTRY[key].title,
      assignment: assignment ? toAssignment(assignment) : null,
      effective: config
        ? {
            source: assignment ? 'assignment' : 'tenant',
            provider: config.provider,
            model: model ?? config.model,
            configId: config.id,
          }
        : cfg.ANTHROPIC_API_KEY
          ? {
              source: assignment ? 'assignment' : 'platform',
              provider: 'anthropic',
              model: model ?? DEFAULT_MODELS.anthropic,
            }
          : { source: 'none' },
    })
  }
  return c.json({ items })
})

aiAgentModelsRouter.put('/:promptKey', validate('json', upsertAgentModelRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const promptKey = keyParam(c)
  const body = c.req.valid('json')
  const aiConfigId = body.aiConfigId ?? null
  const model = body.model ?? null
  if (aiConfigId && !(await findChatConfigById(db, tenantId, aiConfigId))) {
    throw new NotFoundError('AI chat config not found', 'ai_config_not_found')
  }
  const [row] = await db
    .insert(agentModels)
    .values({ tenantId, promptKey, aiConfigId, model })
    .onConflictDoUpdate({
      target: [agentModels.tenantId, agentModels.promptKey],
      set: { aiConfigId, model, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error('agent_models: upsert returned no row')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'agent_model.assigned',
      subjectType: 'Prompt',
      subjectId: promptKey,
      metadata: { aiConfigId: aiConfigId ?? undefined, model: model ?? undefined },
    })
  )
  return c.json(toAssignment(row))
})

aiAgentModelsRouter.delete('/:promptKey', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const promptKey = keyParam(c)
  const deleted = await db
    .delete(agentModels)
    .where(and(eq(agentModels.tenantId, tenantId), eq(agentModels.promptKey, promptKey)))
    .returning({ promptKey: agentModels.promptKey })
  if (deleted.length > 0) {
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'agent_model.reverted',
        subjectType: 'Prompt',
        subjectId: promptKey,
      })
    )
  }
  return c.body(null, 204)
})
