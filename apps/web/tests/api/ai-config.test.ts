/**
 * `/api/ai/config`: upsert encrypts the key and answers `hasCredential` (never the key);
 * re-save without `apiKey` keeps the stored credential; the first row is default, `isDefault` swaps
 * it inside the scope; delete; list never leaks a key; member 403 on writes / 200 on reads; 401
 * unauthenticated; tenant isolation; readiness tenant / platform / none; provider validation 400s.
 */
import {
  aiConfigSchema,
  aiReadinessSchema,
  DEFAULT_MODELS,
  WORKERS_AI_CHAT_MODEL,
} from '@rocketflare/shared/ai/config'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { decrypt } from '@/api/auth/oauth-encryption'
import { resolveDecisions } from '@/api/services/ai/resolve'
import { loadConfig } from '@/config'
import { aiConfigs } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function actor(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function memberOf(tenantId: string) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'member')
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

/** A TypeSafe-shaped placeholder, built rather than written so no literal looks like a key. */
const fakeTypesafeKey = (label: string) => `ts-${label}-${'0123456789'.repeat(2)}`

const anthropic = (label: string, extra: Record<string, unknown> = {}) => ({
  label,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: `sk-ant-${label}-0123456789abcdef`,
  ...extra,
})

describe('POST /api/ai/config', () => {
  it('201 → encrypted key at rest, hasCredential: true, first row becomes default', async () => {
    const a = await actor()
    const res = await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      { json: anthropic('Main') }
    )
    expect(res.status).toBe(201)
    const body = aiConfigSchema.parse(await json(res))
    expect(body).toMatchObject({
      tenantId: a.tenant.id,
      scope: 'chat',
      provider: 'anthropic',
      label: 'Main',
      isDefault: true,
      hasCredential: true,
      thinking: { enabled: false },
      serviceTier: null,
    })
    expect(body).not.toHaveProperty('apiKey')
    expect(body).not.toHaveProperty('apiKeyEnc')
    const [row] = await db.select().from(aiConfigs).where(eq(aiConfigs.id, body.id))
    expect(row?.apiKeyEnc).toBeTruthy()
    expect(row?.apiKeyEnc).not.toContain('sk-ant')
    expect(await decrypt(row?.apiKeyEnc ?? '', process.env.OAUTH_ENCRYPTION_KEY as string)).toBe(
      'sk-ant-Main-0123456789abcdef'
    )
  })

  it('re-saving the same label without apiKey keeps the credential; with one, replaces it; isDefault swaps within the scope', async () => {
    const a = await actor()
    const first = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          { json: anthropic('A') }
        )
      )
    )
    const second = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          { json: anthropic('B') }
        )
      )
    )
    expect(first.isDefault).toBe(true)
    expect(second.isDefault).toBe(false)

    // Update A's model without a key: still has credential, still default, 200 not 201.
    const upd = await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      { json: { label: 'A', provider: 'anthropic', model: 'claude-opus-4-1' } }
    )
    expect(upd.status).toBe(200)
    const updated = aiConfigSchema.parse(await json(upd))
    expect(updated).toMatchObject({
      id: first.id,
      model: 'claude-opus-4-1',
      hasCredential: true,
      isDefault: true,
    })
    const [rowA] = await db.select().from(aiConfigs).where(eq(aiConfigs.id, first.id))
    expect(await decrypt(rowA?.apiKeyEnc ?? '', process.env.OAUTH_ENCRYPTION_KEY as string)).toBe(
      'sk-ant-A-0123456789abcdef'
    )

    // Make B the default → A loses it, exactly one default in the scope.
    const swap = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          {
            json: {
              label: 'B',
              provider: 'anthropic',
              model: 'claude-sonnet-4-5',
              isDefault: true,
            },
          }
        )
      )
    )
    expect(swap).toMatchObject({ id: second.id, isDefault: true })
    const rows = await db
      .select()
      .from(aiConfigs)
      .where(and(eq(aiConfigs.tenantId, a.tenant.id), eq(aiConfigs.scope, 'chat')))
    expect(rows.filter(r => r.isDefault).map(r => r.id)).toEqual([second.id])

    // An embeddings-scope row is its own default and does not disturb chat.
    const emb = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          {
            json: {
              scope: 'embeddings',
              label: 'Vectors',
              provider: 'workers_ai',
              model: '@cf/baai/bge-m3',
            },
          }
        )
      )
    )
    expect(emb).toMatchObject({ scope: 'embeddings', isDefault: true, hasCredential: false })
  })

  it('typesafe serves the decisions scope only, and decisions takes nothing else', async () => {
    const a = await actor()
    const post = (body: Record<string, unknown>) =>
      request('/api/ai/config', { method: 'POST', headers: a.cookie }, { json: body })
    const chatJev = await post({
      scope: 'chat',
      label: 'Jev',
      provider: 'typesafe',
      model: 'jev-latest',
      apiKey: fakeTypesafeKey('key'),
    })
    expect(chatJev.status).toBe(400)
    expect((await json<{ code: string }>(chatJev)).code).toBe('provider_scope_unsupported')
    const decisionsClaude = await post({ ...anthropic('Claude'), scope: 'decisions' })
    expect(decisionsClaude.status).toBe(400)
    expect((await json<{ code: string }>(decisionsClaude)).code).toBe('provider_scope_unsupported')
    const noKey = await post({
      scope: 'decisions',
      label: 'Jev',
      provider: 'typesafe',
      model: 'jev-latest',
    })
    expect(noKey.status).toBe(400)
  })

  it('validates provider rules → 400 with a code', async () => {
    const a = await actor()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ label: 'x', provider: 'anthropic', model: 'm' }, 'api_key_required'],
      [
        { label: 'x', provider: 'anthropic_compatible', model: 'm', apiKey: 'k' },
        'base_url_required',
      ],
      [
        { label: 'x', scope: 'embeddings', provider: 'anthropic', model: 'm', apiKey: 'k' },
        'provider_scope_unsupported',
      ],
      [
        {
          label: 'x',
          provider: 'openai',
          model: 'm',
          apiKey: 'k',
          thinking: { enabled: true, budgetTokens: 2048 },
        },
        'thinking_unsupported',
      ],
      [
        // A budget is required only by a model that takes one (Claude ≤ 4.5).
        {
          label: 'x',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          apiKey: 'k',
          thinking: { enabled: true },
        },
        'thinking_budget_required',
      ],
      [
        {
          label: 'x',
          provider: 'openai',
          model: 'gpt-4.1',
          apiKey: 'k',
          thinking: { enabled: true },
        },
        'thinking_unsupported',
      ],
      [
        { label: 'x', provider: 'openai', model: 'm', apiKey: 'k', serviceTier: 'priority' },
        'service_tier_unsupported',
      ],
    ]
    for (const [body, code] of cases) {
      const res = await request(
        '/api/ai/config',
        { method: 'POST', headers: a.cookie },
        { json: body }
      )
      expect(res.status, code).toBe(400)
      expect(await json(res)).toMatchObject({ error: expect.any(String), statusCode: 400, code })
    }
    const bad = await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      { json: { label: '' } }
    )
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'validation_failed' })
  })

  it('member → 403 on POST/DELETE, 200 on GET; unauthenticated → 401', async () => {
    const a = await actor()
    const created = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          { json: anthropic('M') }
        )
      )
    )
    const m = await memberOf(a.tenant.id)
    expect(
      (
        await request(
          '/api/ai/config',
          { method: 'POST', headers: m.cookie },
          { json: anthropic('N') }
        )
      ).status
    ).toBe(403)
    expect(
      (await request(`/api/ai/config/${created.id}`, { method: 'DELETE', headers: m.cookie }))
        .status
    ).toBe(403)
    expect((await request('/api/ai/config', { headers: m.cookie })).status).toBe(200)
    expect((await request('/api/ai/config/readiness', { headers: m.cookie })).status).toBe(200)
    const anon = await request('/api/ai/config')
    expect(anon.status).toBe(401)
    expect(await json(anon)).toMatchObject({ error: expect.any(String), statusCode: 401 })
  })
})

describe('GET /api/ai/config + DELETE', () => {
  it('lists only this tenant, never a key; delete → 204 then 404; other tenant → 404', async () => {
    const a = await actor()
    const b = await actor()
    const mine = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: a.cookie },
          { json: anthropic('Mine') }
        )
      )
    )
    await request(
      '/api/ai/config',
      { method: 'POST', headers: b.cookie },
      { json: anthropic('Theirs') }
    )
    const list = await json<{ items: Array<Record<string, unknown>> }>(
      await request('/api/ai/config', { headers: a.cookie })
    )
    expect(list.items.map(i => i.label)).toEqual(['Mine'])
    for (const item of list.items) {
      expect(JSON.stringify(item)).not.toContain('sk-ant')
      expect(item).not.toHaveProperty('apiKeyEnc')
      expect(item.hasCredential).toBe(true)
    }
    expect(
      (await request(`/api/ai/config/${mine.id}`, { method: 'DELETE', headers: b.cookie })).status
    ).toBe(404)
    expect(
      (await request(`/api/ai/config/${mine.id}`, { method: 'DELETE', headers: a.cookie })).status
    ).toBe(204)
    expect(
      (await request(`/api/ai/config/${mine.id}`, { method: 'DELETE', headers: a.cookie })).status
    ).toBe(404)
    expect(
      (await request('/api/ai/config/not-a-uuid', { method: 'DELETE', headers: a.cookie })).status
    ).toBe(404)
  })

  it('GET /providers serves the catalog with scopes and presets', async () => {
    const a = await actor('member')
    const body = await json<{
      items: Array<{ id: string; scopes: string[]; presets: unknown[] }>
      defaultMaxOutputTokens: number
    }>(await request('/api/ai/config/providers', { headers: a.cookie }))
    expect(body.defaultMaxOutputTokens).toBe(16384)
    expect(body.items.find(p => p.id === 'workers_ai')?.scopes).toEqual(['chat', 'embeddings'])
    expect(body.items.find(p => p.id === 'anthropic_compatible')?.presets.length).toBeGreaterThan(0)
  })
})

describe('GET /api/ai/config/readiness', () => {
  it('none → platform → tenant, per scope', async () => {
    const a = await actor()
    const bare = createTestEnv({ ANTHROPIC_API_KEY: '', EMBEDDINGS_API_KEY: '', AI: undefined })
    let r = aiReadinessSchema.parse(
      await json(await request('/api/ai/config/readiness', { headers: a.cookie }, { env: bare }))
    )
    expect(r).toEqual({
      chat: { ready: false, source: 'none' },
      embeddings: { ready: false, source: 'none' },
      decisions: { ready: false, source: 'none' },
    })

    const platform = createTestEnv({
      ANTHROPIC_API_KEY: 'sk-ant-platform-0123456789',
      EMBEDDINGS_API_KEY: '',
      AI: undefined,
    })
    r = aiReadinessSchema.parse(
      await json(
        await request('/api/ai/config/readiness', { headers: a.cookie }, { env: platform })
      )
    )
    expect(r.chat).toEqual({
      ready: true,
      source: 'platform',
      provider: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
    })
    expect(r.embeddings.source).toBe('none')
    // No TypeSafe key, so decisions fall back to the chat model — ready, and labelled so.
    expect(r.decisions).toEqual({
      ready: true,
      source: 'fallback',
      provider: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
    })

    // The AI binding makes BOTH scopes ready with no key at all (chat = the Workers AI floor).
    r = aiReadinessSchema.parse(
      await json(
        await request(
          '/api/ai/config/readiness',
          { headers: a.cookie },
          { env: createTestEnv({ ANTHROPIC_API_KEY: '' }) }
        )
      )
    )
    expect(r.embeddings).toEqual({
      ready: true,
      source: 'platform',
      provider: 'workers_ai',
      model: '@cf/baai/bge-m3',
    })
    expect(r.chat).toEqual({
      ready: true,
      source: 'platform',
      provider: 'workers_ai',
      model: WORKERS_AI_CHAT_MODEL,
    })

    await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      { json: anthropic('Tenant', { model: 'claude-opus-4-1' }) }
    )
    r = aiReadinessSchema.parse(
      await json(
        await request('/api/ai/config/readiness', { headers: a.cookie }, { env: platform })
      )
    )
    expect(r.chat).toEqual({
      ready: true,
      source: 'tenant',
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    })
  })

  it('decisions: fallback → platform TypeSafe key → tenant row', async () => {
    const a = await actor()
    const env = createTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-platform-0123456789', AI: undefined })
    const read = async (e = env) =>
      aiReadinessSchema.parse(
        await json(await request('/api/ai/config/readiness', { headers: a.cookie }, { env: e }))
      ).decisions
    expect((await read()).source).toBe('fallback')

    const withKey = createTestEnv({
      ANTHROPIC_API_KEY: 'sk-ant-platform-0123456789',
      TYPESAFE_API_KEY: fakeTypesafeKey('platform'),
      AI: undefined,
    })
    expect(await read(withKey)).toEqual({
      ready: true,
      source: 'platform',
      provider: 'typesafe',
      model: 'jev-latest',
    })

    const saved = await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      {
        json: {
          scope: 'decisions',
          label: 'Jev',
          provider: 'typesafe',
          model: 'jev-latest',
          apiKey: fakeTypesafeKey('tenant'),
        },
      }
    )
    expect(saved.status).toBe(201)
    const row = aiConfigSchema.parse(await json(saved))
    expect(row).toMatchObject({ scope: 'decisions', isDefault: true, hasCredential: true })
    expect(await read(withKey)).toEqual({
      ready: true,
      source: 'tenant',
      provider: 'typesafe',
      model: 'jev-latest',
    })
  })
})

describe('POST /api/ai/config/test', () => {
  it('reports a normalised verdict for an inline candidate (auth failure, no key echoed) and 404 for a foreign id', async () => {
    const a = await actor()
    // No network: an openai_compatible base URL that cannot be reached → `unavailable`, never a throw.
    const res = await request(
      '/api/ai/config/test',
      { method: 'POST', headers: a.cookie },
      {
        json: {
          provider: 'openai_compatible',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'm',
          apiKey: 'sk-should-not-leak-0123456789',
        },
      }
    )
    expect(res.status).toBe(200)
    const body = await json<{ ok: boolean; error?: string; code?: string; model: string }>(res)
    expect(body.ok).toBe(false)
    expect(body.code).toBe('unavailable')
    expect(JSON.stringify(body)).not.toContain('should-not-leak')

    const b = await actor()
    const theirs = aiConfigSchema.parse(
      await json(
        await request(
          '/api/ai/config',
          { method: 'POST', headers: b.cookie },
          { json: anthropic('T') }
        )
      )
    )
    expect(
      (
        await request(
          '/api/ai/config/test',
          { method: 'POST', headers: a.cookie },
          { json: { configId: theirs.id } }
        )
      ).status
    ).toBe(404)
    const m = await memberOf(a.tenant.id)
    expect(
      (
        await request(
          '/api/ai/config/test',
          { method: 'POST', headers: m.cookie },
          { json: { configId: theirs.id } }
        )
      ).status
    ).toBe(403)
  })
})

describe('resolveDecisions', () => {
  it('tenant row → platform TypeSafe key → the chat-model fallback → 503', async () => {
    const a = await actor()
    const resolve = (env: ReturnType<typeof createTestEnv>) =>
      resolveDecisions(db, loadConfig(env), env, a.tenant.id, { fallbackSystem: 'judge' })

    const chatOnly = createTestEnv({
      ANTHROPIC_API_KEY: 'sk-ant-platform-0123456789',
      AI: undefined,
    })
    expect(await resolve(chatOnly)).toMatchObject({
      source: 'fallback',
      method: 'llm_self_report',
      provider: 'anthropic',
    })

    const nothing = createTestEnv({ ANTHROPIC_API_KEY: '', AI: undefined })
    await expect(resolve(nothing)).rejects.toMatchObject({ code: 'ai_not_configured' })

    const withKey = createTestEnv({ TYPESAFE_API_KEY: fakeTypesafeKey('platform'), AI: undefined })
    expect(await resolve(withKey)).toMatchObject({
      source: 'platform',
      method: 'typesafe',
      provider: 'typesafe',
      model: 'jev-latest',
    })

    await request(
      '/api/ai/config',
      { method: 'POST', headers: a.cookie },
      {
        json: {
          scope: 'decisions',
          label: 'Jev',
          provider: 'typesafe',
          model: 'jev-latest',
          apiKey: fakeTypesafeKey('tenant'),
        },
      }
    )
    const tenant = await resolve(withKey)
    expect(tenant).toMatchObject({ source: 'tenant', method: 'typesafe', provider: 'typesafe' })
    expect(tenant.configId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the connection test probes a decisions candidate and never echoes its key', async () => {
    const a = await actor()
    const res = await request(
      '/api/ai/config/test',
      { method: 'POST', headers: a.cookie },
      {
        json: {
          scope: 'decisions',
          provider: 'typesafe',
          baseUrl: 'http://127.0.0.1:9',
          model: 'jev-latest',
          apiKey: fakeTypesafeKey('should-not-leak'),
        },
      }
    )
    expect(res.status).toBe(200)
    const body = await json<{ ok: boolean; code?: string; provider: string }>(res)
    expect(body).toMatchObject({ ok: false, code: 'unavailable', provider: 'typesafe' })
    expect(JSON.stringify(body)).not.toContain('should-not-leak')
  })
})
