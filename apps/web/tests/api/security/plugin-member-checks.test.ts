/**
 * What a plugin learns about the person behind a tool call or a callback: the CASL grant they hold
 * now, not the row-visibility flag and not what they held when a token was minted.
 *
 * The plugin is a fixture (`withServerPlugins`), not the example one an app may delete: its grants
 * make `support` read-only, as a finance or integration plugin's do, and its tool builder records
 * the `can` it is handed.
 */
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessScopeForUser } from '@/api/services/access'
import { buildAgentTools } from '@/api/services/agents/tools'
import { overrideResolveChatForTests } from '@/api/services/ai/resolve'
import { loadConfig } from '@/config'
import { tenants, tenantUsers, users } from '@/db/schema'
import { memberCan, toolCtx } from '@/plugins/api'
import type { AnyServerPlugin } from '@/plugins/server'
import { FakeChatClient } from '../../helpers/ai'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { withServerPlugins } from '../../helpers/server-plugins'
import { createTestEnv, type TestEnv } from '../../mocks/bindings'

const FIXTURE_SUBJECT = 'MemberChecksFixtureNote'
const SUBJECT = FIXTURE_SUBJECT as never

const seen: { can: ((a: never, s: never) => boolean) | null } = { can: null }
const state: { client: FakeChatClient | null } = { client: null }

withServerPlugins([
  {
    shared: { id: 'member-checks-fixture', label: 'Member checks' },
    grants: {
      owner: (can: (a: string, s: string) => void) => can('manage', FIXTURE_SUBJECT),
      admin: (can: (a: string, s: string) => void) => can('manage', FIXTURE_SUBJECT),
      support: (can: (a: string, s: string) => void) => can('read', FIXTURE_SUBJECT),
      member: (can: (a: string, s: string) => void) => {
        can('read', FIXTURE_SUBJECT)
        can('create', FIXTURE_SUBJECT)
      },
    },
    tools: (raw: unknown) => {
      seen.can = (raw as { can?: never }).can ?? null
      return []
    },
  },
] as unknown as AnyServerPlugin[])

overrideResolveChatForTests(async () => ({
  client: state.client as FakeChatClient,
  provider: 'anthropic_compatible',
  model: 'fake-model',
  source: 'tenant',
  billedToPlatform: false,
  maxOutputTokens: 2048,
}))

const db = setupTestDatabase()
const env: TestEnv = createTestEnv()
const config = loadConfig(env)
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const ctx = { db, config, logger, env } as never

beforeEach(() => {
  seen.can = null
  state.client = new FakeChatClient([{ text: 'hello' }], 'anthropic_compatible')
})

async function chatCan(role: 'admin' | 'support' | 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const created = await request(
    '/api/chat/conversations',
    { method: 'POST', headers: cookie },
    { env }
  )
  const conv = await json<{ id: string }>(created)
  await (
    await request(
      `/api/chat/conversations/${conv.id}/messages`,
      { method: 'POST', headers: cookie },
      { env, json: { content: 'hello' } }
    )
  ).text()
  if (!seen.can) throw new Error('the fixture builder never ran')
  return seen.can('manage' as never, SUBJECT)
}

describe('a plugin tool sees the requester’s grant', () => {
  it('in a chat turn: admin holds manage on the plugin subject, support and member do not', async () => {
    expect(await chatCan('admin')).toBe(true)
    expect(await chatCan('support')).toBe(false)
    expect(await chatCan('member')).toBe(false)
  })

  it('in a run: the requester’s current role, and no requester holds nothing', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const { requesterCan } = await import('@/api/services/member-ability')
    const can = await requesterCan(db, config, tenant.id, user.id)
    expect(can('manage', SUBJECT)).toBe(true)
    await db
      .update(tenantUsers)
      .set({ role: 'member' })
      .where(and(eq(tenantUsers.userId, user.id), eq(tenantUsers.tenantId, tenant.id)))
    expect((await requesterCan(db, config, tenant.id, user.id))('manage', SUBJECT)).toBe(false)
    expect((await requesterCan(db, config, tenant.id, null))('read', SUBJECT)).toBe(false)
  })

  it('`toolCtx` answers false when the runtime passed no ability', async () => {
    const { tenant } = await createTestTenantWithUser(db)
    const scope = await accessScopeForUser(db, tenant.id, null)
    await buildAgentTools({ db, cfg: config, env, scope })
    const built = toolCtx({ db, cfg: config, env, scope })
    expect(built.can('read', SUBJECT)).toBe(false)
  })
})

describe('memberCan — is this grant still held, at a callback', () => {
  async function adminOf() {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    return { user, tenant }
  }

  it('answers true for a current member with the grant', async () => {
    const { user, tenant } = await adminOf()
    expect(await memberCan(ctx, { tenantId: tenant.id, userId: user.id }, 'manage', SUBJECT)).toBe(
      true
    )
  })

  it('answers false after a demotion and after removal', async () => {
    const { user, tenant } = await adminOf()
    await db
      .update(tenantUsers)
      .set({ role: 'member' })
      .where(and(eq(tenantUsers.userId, user.id), eq(tenantUsers.tenantId, tenant.id)))
    expect(await memberCan(ctx, { tenantId: tenant.id, userId: user.id }, 'manage', SUBJECT)).toBe(
      false
    )
    await db.delete(tenantUsers).where(eq(tenantUsers.userId, user.id))
    expect(await memberCan(ctx, { tenantId: tenant.id, userId: user.id }, 'read', SUBJECT)).toBe(
      false
    )
  })

  it('answers false for a blocked person and a suspended tenant', async () => {
    const blocked = await adminOf()
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, blocked.user.id))
    expect(
      await memberCan(
        ctx,
        { tenantId: blocked.tenant.id, userId: blocked.user.id },
        'manage',
        SUBJECT
      )
    ).toBe(false)

    const suspended = await adminOf()
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, suspended.tenant.id))
    expect(
      await memberCan(
        ctx,
        { tenantId: suspended.tenant.id, userId: suspended.user.id },
        'manage',
        SUBJECT
      )
    ).toBe(false)
  })

  it('answers false for a person with no membership in that tenant', async () => {
    const other = await createTestTenant(db)
    const stranger = await createTestUser(db)
    await linkUserToTenant(db, stranger.id, (await createTestTenant(db)).id, 'owner')
    expect(await memberCan(ctx, { tenantId: other.id, userId: stranger.id }, 'read', SUBJECT)).toBe(
      false
    )
  })
})
