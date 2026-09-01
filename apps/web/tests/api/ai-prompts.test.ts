/**
 * `/api/ai/prompts` (D17): the registry lists with effective text; PUT overrides (admin+), DELETE
 * reverts; `resolvePrompt` interpolates `{{vars}}` from override or default; unknown key → 404;
 * member 403 on writes; tenant isolation (an override in A is invisible in B).
 */
import { promptListResponseSchema, promptWithResolvedSchema } from '@rocketflare/shared/ai/prompts'
import { describe, expect, it } from 'vitest'
import { PROMPT_REGISTRY, resolvePrompt } from '@/api/services/prompts'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

async function actor(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('/api/ai/prompts', () => {
  it('GET lists the registry with defaults; PUT overrides; DELETE reverts; resolvePrompt interpolates', async () => {
    const a = await actor()
    let list = promptListResponseSchema.parse(
      await json(await request('/api/ai/prompts', { headers: a.cookie }))
    )
    expect(list.items.map(i => i.definition.key)).toEqual([
      'chat',
      'summarize-text',
      'research-topic',
    ])
    expect(list.items[0]).toMatchObject({
      isOverridden: false,
      override: null,
      effectiveText: PROMPT_REGISTRY.chat.defaultText,
    })
    expect(list.items[0]?.definition.variables).toEqual(['appName', 'tenantName', 'userName'])

    const put = await request(
      '/api/ai/prompts/chat',
      { method: 'PUT', headers: a.cookie },
      { json: { text: 'Be terse, {{userName}} of {{tenantName}}. {{unknown}}' } }
    )
    expect(put.status).toBe(200)
    const overridden = promptWithResolvedSchema.parse(await json(put))
    expect(overridden).toMatchObject({
      isOverridden: true,
      effectiveText: 'Be terse, {{userName}} of {{tenantName}}. {{unknown}}',
    })
    expect(overridden.override).toMatchObject({
      tenantId: a.tenant.id,
      key: 'chat',
      updatedByUserId: a.user.id,
    })

    expect(
      await resolvePrompt(db, a.tenant.id, 'chat', { userName: 'Ada', tenantName: 'Acme' })
    ).toBe('Be terse, Ada of Acme. {{unknown}}')
    // Another tenant still resolves the default, interpolated.
    const b = await actor()
    expect(
      await resolvePrompt(db, b.tenant.id, 'chat', {
        appName: 'Kit',
        tenantName: 'B',
        userName: 'Bob',
      })
    ).toContain('built into Kit, helping Bob at B')
    list = promptListResponseSchema.parse(
      await json(await request('/api/ai/prompts', { headers: b.cookie }))
    )
    expect(list.items[0]?.isOverridden).toBe(false)

    // Idempotent re-PUT updates in place; GET /:key shows it; DELETE reverts.
    await request(
      '/api/ai/prompts/chat',
      { method: 'PUT', headers: a.cookie },
      { json: { text: 'v2' } }
    )
    const single = promptWithResolvedSchema.parse(
      await json(await request('/api/ai/prompts/chat', { headers: a.cookie }))
    )
    expect(single.effectiveText).toBe('v2')
    const del = await request('/api/ai/prompts/chat', { method: 'DELETE', headers: a.cookie })
    expect(del.status).toBe(200)
    expect(promptWithResolvedSchema.parse(await json(del))).toMatchObject({
      isOverridden: false,
      effectiveText: PROMPT_REGISTRY.chat.defaultText,
    })
    expect(
      await resolvePrompt(db, a.tenant.id, 'chat', { appName: 'X', tenantName: 'Y', userName: 'Z' })
    ).toContain('built into X')
  })

  it('unknown key → 404 prompt_not_found; empty text → 400; member 403 on write, 200 on read; 401 anon', async () => {
    const a = await actor()
    const nf = await request(
      '/api/ai/prompts/nope',
      { method: 'PUT', headers: a.cookie },
      { json: { text: 'x' } }
    )
    expect(nf.status).toBe(404)
    expect(await json(nf)).toMatchObject({
      error: expect.any(String),
      statusCode: 404,
      code: 'prompt_not_found',
    })
    expect(
      (
        await request(
          '/api/ai/prompts/chat',
          { method: 'PUT', headers: a.cookie },
          { json: { text: '   ' } }
        )
      ).status
    ).toBe(400)

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, a.tenant.id, 'member')
    const mc = sessionCookieHeader(await createTestSession(db, member.id, a.tenant.id))
    expect(
      (
        await request(
          '/api/ai/prompts/chat',
          { method: 'PUT', headers: mc },
          { json: { text: 'x' } }
        )
      ).status
    ).toBe(403)
    expect((await request('/api/ai/prompts/chat', { method: 'DELETE', headers: mc })).status).toBe(
      403
    )
    expect((await request('/api/ai/prompts', { headers: mc })).status).toBe(200)
    expect((await request('/api/ai/prompts')).status).toBe(401)
  })
})
