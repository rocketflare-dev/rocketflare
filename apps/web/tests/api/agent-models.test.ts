/**
 * `/api/ai/agent-models` (D17) + the `resolveChat(..., { promptKey })` branch: the list covers every
 * registry prompt key with what the resolver WILL pick; an assignment to a second config and/or a
 * model changes `resolveChat`'s answer for THAT key only (`source: 'agent'`); a model-only
 * assignment keeps the default config; DELETE reverts (idempotent); deleting the assigned config
 * cascades the assignment; a foreign config id is 404; an unknown key is 404; member writes 403;
 * 401 anon; a body that sets nothing is 400.
 */
import {
  agentModelAssignmentSchema,
  agentModelsListResponseSchema,
} from '@rocketflare/shared/ai/agent-models'
import { aiConfigSchema } from '@rocketflare/shared/ai/config'
import { describe, expect, it } from 'vitest'
import { resolveChat } from '@/api/services/ai/resolve'
import { loadConfig } from '@/config'
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
const env = createTestEnv({ ANTHROPIC_API_KEY: '' })
const cfg = loadConfig(env)

async function admin() {
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function chatConfig(cookie: Record<string, string>, label: string, model: string) {
  return aiConfigSchema.parse(
    await json(
      await request(
        '/api/ai/config',
        { method: 'POST', headers: cookie },
        {
          json: { label, provider: 'anthropic', model, apiKey: `sk-ant-${label}-0123456789abcdef` },
        }
      )
    )
  )
}

const list = async (cookie: Record<string, string>) =>
  agentModelsListResponseSchema.parse(
    await json(await request('/api/ai/agent-models', { headers: cookie }, { env }))
  )

describe('/api/ai/agent-models', () => {
  it('lists every registry key with the tenant default; PUT changes resolveChat for that key only; DELETE reverts', async () => {
    const a = await admin()
    const first = await chatConfig(a.cookie, 'Main', 'claude-sonnet-4-5')
    const second = await chatConfig(a.cookie, 'Strong', 'claude-opus-4-1')
    expect(first.isDefault).toBe(true)

    let items = (await list(a.cookie)).items
    expect(items.map(i => i.promptKey).sort()).toEqual(['chat', 'summarize-text'])
    for (const item of items) {
      expect(item.assignment).toBeNull()
      expect(item.effective).toEqual({
        source: 'tenant',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        configId: first.id,
      })
    }

    // Assign the agent to the second config with an explicit model.
    const put = await request(
      '/api/ai/agent-models/summarize-text',
      { method: 'PUT', headers: a.cookie },
      { env, json: { aiConfigId: second.id, model: 'claude-opus-4-1-20250805' } }
    )
    expect(put.status).toBe(200)
    expect(agentModelAssignmentSchema.parse(await json(put))).toMatchObject({
      promptKey: 'summarize-text',
      aiConfigId: second.id,
      model: 'claude-opus-4-1-20250805',
    })
    items = (await list(a.cookie)).items
    expect(items.find(i => i.promptKey === 'summarize-text')?.effective).toEqual({
      source: 'assignment',
      provider: 'anthropic',
      model: 'claude-opus-4-1-20250805',
      configId: second.id,
    })
    expect(items.find(i => i.promptKey === 'chat')?.effective.configId).toBe(first.id)

    const agent = await resolveChat(db, cfg, env, a.tenant.id, { promptKey: 'summarize-text' })
    expect(agent).toMatchObject({
      source: 'agent',
      model: 'claude-opus-4-1-20250805',
      configId: second.id,
    })
    const chat = await resolveChat(db, cfg, env, a.tenant.id, { promptKey: 'chat' })
    expect(chat).toMatchObject({ source: 'tenant', model: 'claude-sonnet-4-5', configId: first.id })
    const bare = await resolveChat(db, cfg, env, a.tenant.id)
    expect(bare).toMatchObject({ source: 'tenant', model: 'claude-sonnet-4-5', configId: first.id })

    // Model-only: keeps the default config, overrides the model.
    await request(
      '/api/ai/agent-models/chat',
      { method: 'PUT', headers: a.cookie },
      { env, json: { model: 'claude-haiku-4-5' } }
    )
    expect(await resolveChat(db, cfg, env, a.tenant.id, { promptKey: 'chat' })).toMatchObject({
      source: 'agent',
      model: 'claude-haiku-4-5',
      configId: first.id,
    })

    // Revert (idempotent).
    expect(
      (await request('/api/ai/agent-models/chat', { method: 'DELETE', headers: a.cookie }, { env }))
        .status
    ).toBe(204)
    expect(
      (await request('/api/ai/agent-models/chat', { method: 'DELETE', headers: a.cookie }, { env }))
        .status
    ).toBe(204)
    expect(await resolveChat(db, cfg, env, a.tenant.id, { promptKey: 'chat' })).toMatchObject({
      source: 'tenant',
      model: 'claude-sonnet-4-5',
    })

    // Deleting the assigned config cascades the assignment back to the default.
    expect(
      (await request(`/api/ai/config/${second.id}`, { method: 'DELETE', headers: a.cookie })).status
    ).toBe(204)
    expect(
      await resolveChat(db, cfg, env, a.tenant.id, { promptKey: 'summarize-text' })
    ).toMatchObject({
      source: 'tenant',
      model: 'claude-sonnet-4-5',
      configId: first.id,
    })
    expect((await list(a.cookie)).items.every(i => i.assignment === null)).toBe(true)
  })

  it('platform fallback with a model override; none when nothing resolves', async () => {
    const a = await admin()
    const platform = createTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-platform-0123456789' })
    let items = agentModelsListResponseSchema.parse(
      await json(await request('/api/ai/agent-models', { headers: a.cookie }, { env: platform }))
    ).items
    expect(items[0]?.effective).toEqual({
      source: 'platform',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    })
    await request(
      '/api/ai/agent-models/summarize-text',
      { method: 'PUT', headers: a.cookie },
      { env: platform, json: { model: 'claude-opus-4-1' } }
    )
    items = agentModelsListResponseSchema.parse(
      await json(await request('/api/ai/agent-models', { headers: a.cookie }, { env: platform }))
    ).items
    expect(items.find(i => i.promptKey === 'summarize-text')?.effective).toEqual({
      source: 'assignment',
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    })
    expect(
      await resolveChat(db, loadConfig(platform), platform, a.tenant.id, {
        promptKey: 'summarize-text',
      })
    ).toMatchObject({ source: 'agent', provider: 'anthropic', model: 'claude-opus-4-1' })
    items = (await list(a.cookie)).items
    expect(items.find(i => i.promptKey === 'chat')?.effective).toEqual({ source: 'none' })
  })

  it('404 foreign config / unknown key, 400 empty body, 403 member writes, 401 anon; other tenant sees nothing', async () => {
    const a = await admin()
    const b = await admin()
    const theirs = await chatConfig(b.cookie, 'Theirs', 'claude-sonnet-4-5')
    const foreign = await request(
      '/api/ai/agent-models/chat',
      { method: 'PUT', headers: a.cookie },
      { env, json: { aiConfigId: theirs.id } }
    )
    expect(foreign.status).toBe(404)
    expect(await json(foreign)).toMatchObject({ statusCode: 404, code: 'ai_config_not_found' })
    expect(
      (
        await request(
          '/api/ai/agent-models/nope',
          { method: 'PUT', headers: a.cookie },
          { env, json: { model: 'x' } }
        )
      ).status
    ).toBe(404)
    const empty = await request(
      '/api/ai/agent-models/chat',
      { method: 'PUT', headers: a.cookie },
      { env, json: {} }
    )
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ statusCode: 400, code: 'validation_failed' })

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, a.tenant.id, 'member')
    const mc = sessionCookieHeader(await createTestSession(db, member.id, a.tenant.id))
    expect((await request('/api/ai/agent-models', { headers: mc }, { env })).status).toBe(200)
    expect(
      (
        await request(
          '/api/ai/agent-models/chat',
          { method: 'PUT', headers: mc },
          { env, json: { model: 'x' } }
        )
      ).status
    ).toBe(403)
    expect(
      (await request('/api/ai/agent-models/chat', { method: 'DELETE', headers: mc }, { env }))
        .status
    ).toBe(403)
    expect((await request('/api/ai/agent-models', {}, { env })).status).toBe(401)

    await request(
      '/api/ai/agent-models/chat',
      { method: 'PUT', headers: b.cookie },
      { env, json: { model: 'theirs-model' } }
    )
    expect((await list(a.cookie)).items.every(i => i.assignment === null)).toBe(true)
  })
})
