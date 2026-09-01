/**
 * `/api/ai/config` (D17): a tenant's AI providers. Credentials are encrypted on the way in and
 * NEVER come back out (`hasCredential` only). `POST /` upserts on (tenant, scope, label): omitting
 * `apiKey` on a re-save keeps the stored key; `isDefault` swaps the scope's default inside one
 * transaction (clear-others-then-set — the partial unique index rejects the reverse order). The
 * first row in a scope is always made default. `POST /test` spends money at a provider on demand,
 * so it is rate-limited per IP. `GET /readiness` is what the Home checklist reads. `manage AiConfig`
 * = admin+; members may `read` (the list shows what will answer them, not how to change it).
 */
import {
  type AiConfig,
  type AiScope,
  aiReadinessSchema,
  testAiConfigRequestSchema,
  type UpsertAiConfigRequest,
  upsertAiConfigRequestSchema,
} from '@gmgo/shared/ai/config'
import { and, eq, ne } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type AiConfigRow, aiConfigs } from '../../db/schema'
import { encrypt, requireEncryptionKey } from '../auth/oauth-encryption'
import { guardPermission } from '../middleware/permissions'
import { rateLimit } from '../middleware/rate-limit'
import { recordActivity } from '../services/activity'
import { testConfig } from '../services/ai/connection-test'
import { PROVIDERS, providerInfo, providerSupportsScope } from '../services/ai/providers'
import { readiness } from '../services/ai/resolve'
import { BadRequestError, NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiConfigRouter = createRouter()

/** 10 tests / minute / IP — authenticated and admin-only, but every call spends provider money. */
const aiTestRateLimit = rateLimit({ name: 'ai-test', max: 10, windowSeconds: 60 })

export function toAiConfig(row: AiConfigRow): AiConfig {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: row.scope,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    hasCredential: row.apiKeyEnc !== null,
    thinking: row.thinking,
    serviceTier: row.serviceTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Provider × scope × field rules the contract alone cannot express. */
function validateUpsert(body: UpsertAiConfigRequest, existing: AiConfigRow | undefined): void {
  const info = providerInfo(body.provider)
  if (!providerSupportsScope(body.provider, body.scope)) {
    throw new BadRequestError(
      `${info.name} has no ${body.scope} adapter`,
      'provider_scope_unsupported'
    )
  }
  if (info.needsBaseUrl && !body.baseUrl) {
    throw new BadRequestError(`${info.name} requires a base URL`, 'base_url_required')
  }
  // A key is required unless the row already holds one FOR THE SAME PROVIDER (a stored credential
  // belongs to the provider it was entered for and will not authenticate elsewhere).
  const keepsKey = existing?.apiKeyEnc && existing.provider === body.provider
  if (info.needsApiKey && !body.apiKey && !keepsKey) {
    throw new BadRequestError(`${info.name} requires an API key`, 'api_key_required')
  }
  if (body.thinking?.enabled && !info.supportsThinking) {
    throw new BadRequestError(
      `${info.name} does not accept an extended-thinking budget`,
      'thinking_unsupported'
    )
  }
  if (body.thinking?.enabled && !body.thinking.budgetTokens) {
    throw new BadRequestError(
      'Enabling thinking needs a budgetTokens value',
      'thinking_budget_required'
    )
  }
  if (body.serviceTier && !info.supportsServiceTier) {
    throw new BadRequestError(
      `${info.name} does not offer service tiers`,
      'service_tier_unsupported'
    )
  }
}

/** Make `id` the sole default for its scope. Clears the others FIRST (partial unique index). */
async function makeDefault(
  tx: Database,
  tenantId: string,
  scope: AiScope,
  id: string
): Promise<void> {
  await tx
    .update(aiConfigs)
    .set({ isDefault: false })
    .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.scope, scope), ne(aiConfigs.id, id)))
  await tx
    .update(aiConfigs)
    .set({ isDefault: true })
    .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.id, id)))
}

async function hasDefault(tx: Database, tenantId: string, scope: AiScope): Promise<boolean> {
  const row = await tx.query.aiConfigs.findFirst({
    columns: { id: true },
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, scope),
      eq(aiConfigs.isDefault, true)
    ),
  })
  return Boolean(row)
}

// ---- GET /api/ai/config ------------------------------------------------------------------------

aiConfigRouter.get('/', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  const rows = await db.query.aiConfigs.findMany({
    where: eq(aiConfigs.tenantId, tenantId),
    orderBy: (t, { asc }) => [asc(t.scope), asc(t.label)],
  })
  return c.json({ items: rows.map(toAiConfig) })
})

/** Static catalog for the settings form (what each provider needs, presets, suggested models). */
aiConfigRouter.get('/providers', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  return c.json({
    items: PROVIDERS,
    defaultMaxOutputTokens: c.get('config').AGENT_MAX_OUTPUT_TOKENS,
  })
})

aiConfigRouter.get('/readiness', async c => {
  const { db, tenantId, cfg } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  return c.json(aiReadinessSchema.parse(await readiness(db, cfg, c.env, tenantId)))
})

// ---- POST /api/ai/config/test --------------------------------------------------------------------

aiConfigRouter.post(
  '/test',
  aiTestRateLimit,
  validate('json', testAiConfigRequestSchema),
  async c => {
    const { db, tenantId, cfg } = withAuthAndDb(c)
    guardPermission(c, 'manage', 'AiConfig')
    return c.json(await testConfig(db, cfg, c.env, tenantId, c.req.valid('json')))
  }
)

// ---- POST /api/ai/config (upsert) -----------------------------------------------------------------

aiConfigRouter.post('/', validate('json', upsertAiConfigRequestSchema), async c => {
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const body = c.req.valid('json')
  const existing = await db.query.aiConfigs.findFirst({
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, body.scope),
      eq(aiConfigs.label, body.label)
    ),
  })
  validateUpsert(body, existing)
  const apiKeyEnc = body.apiKey ? await encrypt(body.apiKey, requireEncryptionKey(cfg)) : undefined
  // A provider change without a new key must not carry the old provider's credential along.
  const dropKey = !body.apiKey && existing && existing.provider !== body.provider

  const values = {
    tenantId,
    scope: body.scope,
    provider: body.provider,
    label: body.label,
    baseUrl: body.baseUrl ?? null,
    model: body.model,
    thinking: body.thinking ?? { enabled: false },
    serviceTier: body.serviceTier ? body.serviceTier : null,
    ...(apiKeyEnc !== undefined ? { apiKeyEnc } : dropKey ? { apiKeyEnc: null } : {}),
  }

  const saved = await db.transaction(async tx => {
    // `isDefault` is deliberately NOT in `values`: it is a cross-row invariant applied by
    // `makeDefault` after the row exists. `apiKeyEnc` is only in the SET when a key was supplied.
    const [row] = await tx
      .insert(aiConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [aiConfigs.tenantId, aiConfigs.scope, aiConfigs.label],
        set: { ...values, updatedAt: new Date() },
      })
      .returning()
    if (!row) throw new Error('ai_configs: upsert returned no row')
    if (body.isDefault || !(await hasDefault(tx, tenantId, body.scope))) {
      await makeDefault(tx, tenantId, body.scope, row.id)
      return { ...row, isDefault: true }
    }
    return row
  })

  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: existing ? 'ai_config.updated' : 'ai_config.created',
      subjectType: 'AiConfig',
      subjectId: saved.id,
      metadata: {
        scope: saved.scope,
        provider: saved.provider,
        label: saved.label,
        model: saved.model,
      },
    })
  )
  return c.json(toAiConfig(saved), existing ? 200 : 201)
})

// ---- DELETE /api/ai/config/:id --------------------------------------------------------------------

aiConfigRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const id = uuidParam(c, 'id')
  const [row] = await db
    .delete(aiConfigs)
    .where(and(eq(aiConfigs.id, id), eq(aiConfigs.tenantId, tenantId)))
    .returning()
  if (!row) throw new NotFoundError('AI config not found')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'ai_config.deleted',
      subjectType: 'AiConfig',
      subjectId: row.id,
      metadata: { scope: row.scope, provider: row.provider, label: row.label },
    })
  )
  return c.body(null, 204)
})
