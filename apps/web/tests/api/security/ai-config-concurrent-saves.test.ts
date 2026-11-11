/**
 * Two saves of the same AI config at once: the second decides whether the stored key stays on the
 * row the first one wrote, never on what it read before that save committed. A key therefore never
 * ends up beside an endpoint it was not saved with, for an existing row or for two first saves.
 *
 * The first save is played by the test's own transaction, held open until the route's save is
 * waiting on it, so the interleaving is the same on every run.
 */
import { aiConfigSchema } from '@rocketflare/shared/ai/config'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { rows } from '@/db/client'
import { aiConfigs } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const OTHER_KEY_ENC = 'stored-key-of-the-other-save'

async function owner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { tenant, cookie }
}

function save(cookie: Record<string, string>, body: Record<string, unknown>) {
  return request(
    '/api/ai/config',
    { method: 'POST', headers: cookie },
    { env: createTestEnv(), json: body }
  )
}

/** Resolves once some backend is waiting for a lock on `ai_configs` — the route's save. */
async function untilASaveWaits(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%ai_configs%'
    `)
    if ((rows<{ n: number }>(result)[0]?.n ?? 0) > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the save never waited on the open transaction')
}

const current = async (tenantId: string, label: string) =>
  (
    await db
      .select()
      .from(aiConfigs)
      .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.label, label)))
  )[0]

describe('concurrent AI config saves', () => {
  it('a save keeping the key decides on the endpoint the other save just wrote', async () => {
    const { tenant, cookie } = await owner()
    const label = `race-${uniqueId()}`
    const body = {
      scope: 'chat',
      provider: 'openai_compatible',
      label,
      baseUrl: 'https://first.example/v1',
      model: 'm',
    }
    const created = await save(cookie, { ...body, apiKey: 'test-key-for-first' })
    expect(created.status).toBe(201)
    const { id } = aiConfigSchema.parse(await json(created))

    let keepingSave: Promise<Response> | undefined
    await db.transaction(async tx => {
      await tx.select().from(aiConfigs).where(eq(aiConfigs.id, id)).for('update')
      // Re-saves the endpoint the row holds now, without a key: "keep my stored key".
      keepingSave = save(cookie, body)
      await untilASaveWaits()
      await tx
        .update(aiConfigs)
        .set({ baseUrl: 'https://second.example/v1', apiKeyEnc: OTHER_KEY_ENC })
        .where(eq(aiConfigs.id, id))
    })
    const res = (await keepingSave) as Response
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'api_key_required' })
    expect(await current(tenant.id, label)).toMatchObject({
      baseUrl: 'https://second.example/v1',
      apiKeyEnc: OTHER_KEY_ENC,
    })
  })

  it('two first saves: the later one decides on the row the earlier one created', async () => {
    const { tenant, cookie } = await owner()
    const label = `race-${uniqueId()}`
    let laterSave: Promise<Response> | undefined
    await db.transaction(async tx => {
      await tx.insert(aiConfigs).values({
        tenantId: tenant.id,
        scope: 'embeddings',
        provider: 'workers_ai',
        label,
        baseUrl: 'https://first.example/v1',
        model: '@cf/baai/bge-m3',
        apiKeyEnc: OTHER_KEY_ENC,
      })
      laterSave = save(cookie, {
        scope: 'embeddings',
        provider: 'workers_ai',
        label,
        baseUrl: 'https://second.example/v1',
        model: '@cf/baai/bge-m3',
      })
      await untilASaveWaits()
    })
    const res = (await laterSave) as Response
    expect(res.status).toBe(200)
    expect(await current(tenant.id, label)).toMatchObject({
      baseUrl: 'https://second.example/v1',
      apiKeyEnc: null,
    })
  })
})
