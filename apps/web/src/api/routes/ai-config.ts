/**
 * `/api/ai/config`: a tenant's AI providers. Credentials are encrypted on the way in and
 * NEVER come back out (`hasCredential` only). `POST /` upserts on (tenant, scope, label): omitting
 * `apiKey` on a re-save keeps the stored key while the provider and endpoint are unchanged, decided
 * on the row the save overwrites (read `FOR UPDATE` inside the save's transaction); `isDefault` swaps the scope's default inside one
 * transaction (clear-others-then-set — the partial unique index rejects the reverse order). The
 * first row in a scope is always made default. `POST /test` spends money at a provider on demand,
 * so it is rate-limited per IP. `GET /readiness` is what the Home checklist reads. `manage AiConfig`
 * = admin+; members may `read` (the list shows what will answer them, not how to change it).
 */
import {
  type AiConfig,
  type AiScope,
  aiReadinessSchema,
  sameAiEndpoint,
  testAiConfigRequestSchema,
  type UpsertAiConfigRequest,
  upsertAiConfigRequestSchema,
} from '@rocketflare/shared/ai/config'
import { modelTraits } from '@rocketflare/shared/ai/models'
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

/**
 * A stored credential belongs to the provider and the endpoint it was entered for: it is never sent
 * anywhere the person who entered it did not choose, so changing either needs the key again.
 */
function keepsStoredKey(existing: AiConfigRow | undefined, body: UpsertAiConfigRequest): boolean {
  if (!existing?.apiKeyEnc) return false
  return existing.provider === body.provider && sameAiEndpoint(existing.baseUrl, body.baseUrl)
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
  // A key is required unless the row already holds one for this provider and endpoint.
  if (info.needsApiKey && !body.apiKey && !keepsStoredKey(existing, body)) {
    throw new BadRequestError(`${info.name} requires an API key`, 'api_key_required')
  }
  // What thinking means is per MODEL (`@rocketflare/shared/ai/models`): a budget only where the
  // model takes one (Claude ≤ 4.5, compatible vendors); adaptive and effort models take a switch.
  const traits = modelTraits(body.provider, body.model)
  if (body.thinking?.enabled && (!info.supportsThinking || traits.thinking === 'none')) {
    throw new BadRequestError(
      `${info.name} · ${body.model} has no thinking control`,
      'thinking_unsupported'
    )
  }
  if (body.thinking?.enabled && traits.thinking === 'extended' && !body.thinking.budgetTokens) {
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

/** The row a save would overwrite, locked until the transaction ends (none yet → undefined). */
async function lockConfig(
  tx: Database,
  tenantId: string,
  scope: AiScope,
  label: string
): Promise<AiConfigRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiConfigs)
    .where(
      and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.scope, scope), eq(aiConfigs.label, label))
    )
    .for('update')
  return row
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
  const apiKeyEnc = body.apiKey ? await encrypt(body.apiKey, requireEncryptionKey(cfg)) : undefined
  const fields = {
    tenantId,
    scope: body.scope,
    provider: body.provider,
    label: body.label,
    baseUrl: body.baseUrl ?? null,
    model: body.model,
    thinking: body.thinking ?? { enabled: false },
    serviceTier: body.serviceTier ? body.serviceTier : null,
  }

  // Whether the stored key stays is decided on the row this save overwrites, read under a row
  // lock: a concurrent save to the same (tenant, scope, label) waits, then decides on what the
  // first one wrote — so a key never ends up beside an endpoint it was not saved with.
  const { saved, existing } = await db.transaction(async tx => {
    let existing = await lockConfig(tx, tenantId, body.scope, body.label)
    let row: AiConfigRow | undefined
    if (!existing) {
      validateUpsert(body, undefined)
      // `isDefault` is deliberately NOT in the values: it is a cross-row invariant applied by
      // `makeDefault` after the row exists. A concurrent first save makes this a no-op; that
      // row is then locked and decided on below like any other.
      ;[row] = await tx
        .insert(aiConfigs)
        .values({ ...fields, ...(apiKeyEnc !== undefined && { apiKeyEnc }) })
        .onConflictDoNothing({ target: [aiConfigs.tenantId, aiConfigs.scope, aiConfigs.label] })
        .returning()
      if (!row) existing = await lockConfig(tx, tenantId, body.scope, body.label)
    }
    if (existing) {
      validateUpsert(body, existing)
      // A provider or endpoint change without a new key must not carry the old credential along.
      const keyChange =
        apiKeyEnc !== undefined
          ? { apiKeyEnc }
          : keepsStoredKey(existing, body)
            ? {}
            : { apiKeyEnc: null }
      ;[row] = await tx
        .update(aiConfigs)
        .set({ ...fields, ...keyChange, updatedAt: new Date() })
        .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.id, existing.id)))
        .returning()
    }
    if (!row) throw new Error('ai_configs: upsert returned no row')
    if (body.isDefault || !(await hasDefault(tx, tenantId, body.scope))) {
      await makeDefault(tx, tenantId, body.scope, row.id)
      return { saved: { ...row, isDefault: true }, existing }
    }
    return { saved: row, existing }
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
