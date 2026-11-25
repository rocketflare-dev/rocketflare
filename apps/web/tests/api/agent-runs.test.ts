/**
 * The `summarize-text` example agent through `/api/agents`: listed with its own prompt key, its
 * input schema renders a required `text` field, and an enqueue stores the input with the schema's
 * defaults applied (`style: 'bullets'`, `index: false`). The route behaviour every agent shares —
 * enqueue, dedupe, validation, visibility, cancel, reconcile — is `agent-run-routes.test.ts`, on
 * the fixture agent, so it outlives this example.
 */
import {
  agentListResponseSchema,
  createAgentRunResponseSchema,
} from '@rocketflare/shared/ai/agents'
import { describe, expect, it } from 'vitest'
import { fieldsFromJsonSchema } from '@/ui/pages/agents/fields/schemaFields'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function actor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('summarize-text through /api/agents', () => {
  it('is listed with its prompt key, exclusive, and a schema the field renderer turns into a required text field', async () => {
    const a = await actor()
    const body = agentListResponseSchema.parse(
      await json(await request('/api/agents', { headers: a.cookie }))
    )
    const summarize = body.items.find(i => i.key === 'summarize-text')
    expect(summarize).toEqual(
      expect.objectContaining({
        key: 'summarize-text',
        promptKey: 'summarize-text',
        exclusive: true,
        title: expect.any(String),
      })
    )
    expect(fieldsFromJsonSchema(summarize?.inputJsonSchema)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'text', required: true })])
    )
  })

  it('stores the input with its defaults applied', async () => {
    const a = await actor()
    const res = await request(
      '/api/agents/runs',
      { method: 'POST', headers: a.cookie },
      { env: createTestEnv(), json: { agentKey: 'summarize-text', input: { text: 'Some text.' } } }
    )
    expect(res.status).toBe(202)
    const run = createAgentRunResponseSchema.parse(await json(res))
    expect(run).toMatchObject({
      agentKey: 'summarize-text',
      status: 'queued',
      input: { text: 'Some text.', style: 'bullets', index: false },
    })
  })
})
