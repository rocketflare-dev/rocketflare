/** Command tests (D26): tables vs `--json`, not-logged-in / forbidden exits, env key, config commands. */
import { afterEach, describe, expect, it } from 'vitest'
import { runActivityList } from '../src/commands/activity'
import { runConfigGet, runConfigPath, runConfigSet } from '../src/commands/config'
import { runKeysList } from '../src/commands/keys'
import { runMembersList } from '../src/commands/members'
import { runStatus } from '../src/commands/status'
import { runWhoami } from '../src/commands/whoami'
import { EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN, exitCodeFor, NotLoggedInError } from '../src/errors'
import {
  captureError,
  headersOf,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({
    serverUrl: SERVER,
    apiKey: TEST_KEY,
    tenantId: TENANT_ID,
    tenantName: 'Acme',
  })
  return t.store
}

const membersBody = {
  items: [
    {
      userId: USER_ID,
      email: 'alice@example.com',
      name: 'Alice',
      avatarUrl: null,
      role: 'owner',
      joinedAt: '2026-01-05T10:00:00.000Z',
      lastLoginAt: '2026-08-30T09:30:00.000Z',
      invitedByUserId: null,
    },
    {
      userId: '99999999-8888-4777-8666-555555555556',
      email: 'bob@example.com',
      name: 'Bob',
      avatarUrl: null,
      role: 'member',
      joinedAt: '2026-02-01T10:00:00.000Z',
      lastLoginAt: null,
      invitedByUserId: USER_ID,
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
}

describe('members list', () => {
  it('renders a table and passes page/pageSize', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/members': () => jsonResponse(membersBody) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runMembersList(ctx, { page: 2, pageSize: 10 })
    const text = out.content()
    expect(text).toMatch(/Email\s+Name\s+Role\s+Joined\s+Last login/)
    expect(text).toContain('alice@example.com')
    expect(text).toMatch(/bob@example.com\s+Bob\s+member\s+2026-02-01 \d\d:\d\d\s+-/)
    expect(text).toContain('Page 1/1 · 2 total')
    expect(api.calls[0]?.url.search).toBe('?page=2&pageSize=10')
    expect(headersOf(api.calls).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('--json prints the raw body only', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/members': () => jsonResponse(membersBody) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runMembersList(ctx)
    expect(JSON.parse(out.content())).toEqual(membersBody)
    expect(out.chunks).toHaveLength(1)
  })

  it('throws NotLoggedInError (exit 2) without a key', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { ctx } = await testContext({ store: t.store })
    const error = await captureError(runMembersList(ctx))
    expect(error).toBeInstanceOf(NotLoggedInError)
    expect(exitCodeFor(error)).toBe(EXIT_NOT_LOGGED_IN)
    expect(error.hint).toContain('gmgo login')
  })

  it('uses GMGO_API_KEY from the environment when set', async () => {
    const t = await tempStore({ GMGO_API_KEY: 'env-key', GMGO_URL: SERVER })
    cleanups.push(t.cleanup)
    const api = mockFetch({ '/api/members': () => jsonResponse(membersBody) })
    const { ctx } = await testContext({ store: t.store, fetch: api.fetch })
    await runMembersList(ctx)
    expect(headersOf(api.calls).Authorization).toBe('Bearer env-key')
  })
})

describe('keys list', () => {
  const key = {
    id: '11111111-2222-4333-8444-555555555556',
    name: 'cli:laptop',
    keyPrefix: 'gmgo_tes',
    scopes: ['read', 'write'],
    createdByUserId: USER_ID,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
  it('accepts a bare array', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({
      store,
      fetch: mockFetch({ '/api/keys': () => jsonResponse([key]) }).fetch,
    })
    await runKeysList(ctx)
    expect(out.content()).toMatch(/cli:laptop\s+gmgo_tes\s+read,write/)
    expect(out.content()).not.toContain('Page ')
  })
  it('accepts a paginated envelope', async () => {
    const store = await loggedInStore()
    const body = { items: [key], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } }
    const { ctx, out } = await testContext({
      store,
      fetch: mockFetch({ '/api/keys': () => jsonResponse(body) }).fetch,
    })
    await runKeysList(ctx)
    expect(out.content()).toContain('cli:laptop')
    expect(out.content()).toContain('Page 1/1')
  })
})

describe('activity list', () => {
  it('renders events and maps 403 to exit 3', async () => {
    const store = await loggedInStore()
    const body = {
      items: [
        {
          id: '11111111-2222-4333-8444-555555555557',
          tenantId: TENANT_ID,
          userId: USER_ID,
          type: 'member.invited',
          subjectType: 'invitation',
          subjectId: 'inv-1',
          metadata: { email: 'x@y.z' },
          createdAt: '2026-08-31T12:00:00.000Z',
          actor: { name: 'Alice', email: 'alice@example.com' },
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    }
    const okApi = mockFetch({ '/api/activity': () => jsonResponse(body) })
    const { ctx, out } = await testContext({ store, fetch: okApi.fetch })
    await runActivityList(ctx, { type: 'member.invited' })
    expect(out.content()).toMatch(/member\.invited\s+alice@example\.com\s+invitation:inv-1/)
    expect(okApi.calls[0]?.url.search).toBe('?type=member.invited')

    const forbidden = mockFetch({
      '/api/activity': () =>
        jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403),
    })
    const { ctx: ctx2 } = await testContext({ store, fetch: forbidden.fetch })
    const error = await captureError(runActivityList(ctx2))
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('whoami', () => {
  it('shows user + tenant and never the full key', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/me': () =>
        jsonResponse({
          id: USER_ID,
          email: 'alice@example.com',
          name: 'Alice',
          isGlobalAdmin: false,
        }),
      '/api/tenant': () => jsonResponse({ id: TENANT_ID, name: 'Acme Inc', slug: 'acme' }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runWhoami(ctx)
    const text = out.content()
    expect(text).toContain('Alice <alice@example.com>')
    expect(text).toContain('Acme Inc')
    expect(text).toContain('gmgo_tes…')
    expect(text).not.toContain(TEST_KEY)
  })

  it('falls back to the stored tenant when /api/tenant is forbidden, and is redacted under --json', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/me': () => jsonResponse({ email: 'alice@example.com', name: 'Alice' }),
      '/api/tenant': () => jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runWhoami(ctx)
    const json = JSON.parse(out.content())
    expect(json.user.email).toBe('alice@example.com')
    expect(json.tenant).toBeNull()
    expect(json.apiKey).toBe('gmgo_tes…')
    expect(out.content()).not.toContain(TEST_KEY)
  })
})

describe('status', () => {
  it('reports health and login state', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/health': () => jsonResponse({ status: 'ok', version: '1.2.3', env: 'development' }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runStatus(ctx)
    expect(out.content()).toContain('ok · v1.2.3 · development')
    expect(out.content()).toContain('signed in')
    expect(headersOf(api.calls).Authorization).toBeUndefined()
  })

  it('fails with a friendly network error (exit 1) when the server is down', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { ctx } = await testContext({
      store: t.store,
      server: 'http://127.0.0.1:9',
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        ),
    })
    const error = await captureError(runStatus(ctx))
    expect(error.message).toContain('Could not reach http://127.0.0.1:9')
    expect(exitCodeFor(error)).toBe(1)
  })
})

describe('config commands', () => {
  it('get redacts, set validates, path prints the file', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store, json: true })
    await runConfigGet(ctx)
    expect(out.content()).not.toContain(TEST_KEY)
    expect(JSON.parse(out.content()).apiKey).toBe('gmgo_tes…')

    const { ctx: c2, out: o2 } = await testContext({ store })
    await runConfigGet(c2, 'apiKey')
    expect(o2.content().trim()).toBe('gmgo_tes…')

    await expect(runConfigSet(c2, 'serverUrl', 'not a url')).rejects.toThrow(/not a valid URL/)
    await expect(runConfigSet(c2, 'bogus', 'x')).rejects.toThrow(/Unknown config key/)
    await runConfigSet(c2, 'serverUrl', 'https://app.example.com/')
    expect((await store.load()).serverUrl).toBe('https://app.example.com')

    const { ctx: c3, out: o3 } = await testContext({ store })
    await runConfigPath(c3)
    expect(o3.content().trim()).toBe(store.file)
  })
})
