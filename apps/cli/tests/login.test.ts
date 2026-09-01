/** Login handoff tests (D26): real loopback server, simulated browser redirect, stubbed `open`, redaction. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAuthUrl,
  CALLBACK_PORT_END,
  CALLBACK_PORT_START,
  loginFlow,
  logoutFlow,
  startCallbackServer,
} from '../src/auth'
import { createMemoryLogger } from '../src/utils/logger'
import { jsonResponse, mockFetch, TENANT_ID, TEST_KEY, tempStore, USER_ID } from './helpers'

const SERVER = 'http://server.test'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

/** A stand-in for the browser: parse `redirect_uri` from the auth URL and hit it with `params`. */
function browser(params: Record<string, string>) {
  const seen: string[] = []
  const open = async (url: string) => {
    seen.push(url)
    const redirect = new URL(url).searchParams.get('redirect_uri')
    if (!redirect) throw new Error('no redirect_uri')
    const target = new URL(redirect)
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
    // Don't await inside open(): the real browser is asynchronous too.
    void fetch(target).then(r => r.text())
  }
  return { open, seen }
}

describe('buildAuthUrl', () => {
  it('points at /auth/cli with an encoded redirect_uri', () => {
    expect(buildAuthUrl(`${SERVER}/`, 'http://127.0.0.1:8765/callback')).toBe(
      `${SERVER}/auth/cli?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback`
    )
  })
})

describe('callback server', () => {
  it('listens on 127.0.0.1 within 8765–8770 and serves a self-closing success page', async () => {
    const cb = await startCallbackServer(5_000)
    try {
      expect(cb.port).toBeGreaterThanOrEqual(CALLBACK_PORT_START)
      expect(cb.port).toBeLessThanOrEqual(CALLBACK_PORT_END)
      expect(cb.url).toBe(`http://127.0.0.1:${cb.port}/callback`)
      const res = await fetch(
        `${cb.url}?key=${TEST_KEY}&tenant_id=${TENANT_ID}&tenant_name=Acme%20%3Cco%3E`
      )
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('You can return to the terminal')
      expect(html).toContain('window.close()')
      expect(html).toContain('Acme &#60;co&#62;')
      expect(html).not.toContain(TEST_KEY)
      await expect(cb.result).resolves.toEqual({
        key: TEST_KEY,
        tenantId: TENANT_ID,
        tenantName: 'Acme <co>',
      })
    } finally {
      cb.close()
    }
  })

  it('moves to the next port when one is taken', async () => {
    const a = await startCallbackServer(5_000)
    const b = await startCallbackServer(5_000)
    try {
      expect(b.port).toBe(a.port + 1)
    } finally {
      a.close()
      b.close()
    }
  })

  it('rejects on ?error= and on missing key/tenant_id, 404s other paths', async () => {
    const cb = await startCallbackServer(5_000)
    try {
      expect((await fetch(`http://127.0.0.1:${cb.port}/other`)).status).toBe(404)
      const res = await fetch(`${cb.url}?key=${TEST_KEY}`)
      expect(res.status).toBe(400)
      await expect(cb.result).rejects.toThrow(/missing required parameter\(s\): tenant_id/)
    } finally {
      cb.close()
    }
    const cb2 = await startCallbackServer(5_000)
    try {
      const res = await fetch(`${cb2.url}?error=access_denied`)
      expect(res.status).toBe(400)
      await expect(cb2.result).rejects.toThrow(/Sign-in failed: access_denied/)
    } finally {
      cb2.close()
    }
  })

  it('times out', async () => {
    const cb = await startCallbackServer(50)
    try {
      await expect(cb.result).rejects.toThrow(/Timed out/)
    } finally {
      cb.close()
    }
  })
})

describe('loginFlow', () => {
  it('opens the browser, receives the callback, fetches /api/me, writes config, redacts the key', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const api = mockFetch({
      '/api/me': (_url, init) => {
        const auth = (init.headers as Record<string, string>).Authorization
        if (auth !== `Bearer ${TEST_KEY}`) {
          return jsonResponse({ error: 'Unauthorized', statusCode: 401, code: 'unauthorized' }, 401)
        }
        return jsonResponse({ id: USER_ID, email: 'alice@example.com', name: 'Alice' })
      },
    })
    const b = browser({ key: TEST_KEY, tenant_id: TENANT_ID, tenant_name: 'Acme' })
    const log = createMemoryLogger()

    const result = await loginFlow({
      serverUrl: SERVER,
      store: t.store,
      log,
      open: b.open,
      fetch: api.fetch,
    })

    expect(b.seen).toHaveLength(1)
    const opened = new URL(b.seen[0] ?? '')
    expect(opened.origin + opened.pathname).toBe(`${SERVER}/auth/cli`)
    expect(opened.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:87(6[5-9]|70)\/callback$/
    )

    expect(await t.store.load()).toEqual({
      serverUrl: SERVER,
      apiKey: TEST_KEY,
      tenantId: TENANT_ID,
      tenantName: 'Acme',
      user: { email: 'alice@example.com', name: 'Alice' },
    })
    expect(result).toMatchObject({
      tenantId: TENANT_ID,
      tenantName: 'Acme',
      keyPrefix: 'rocketflare_test…',
    })
    const output = log.lines.join('\n')
    expect(output).toContain('Signed in as alice@example.com')
    expect(output).toContain('rocketflare_test…')
    expect(output).not.toContain(TEST_KEY)
  })

  it('fails when the server rejects the new key on /api/me (401)', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const api = mockFetch({
      '/api/me': () =>
        jsonResponse({ error: 'Unauthorized', statusCode: 401, code: 'unauthorized' }, 401),
    })
    const b = browser({ key: 'rocketflare_bad_key_value_here', tenant_id: TENANT_ID })
    await expect(
      loginFlow({
        serverUrl: SERVER,
        store: t.store,
        log: createMemoryLogger(),
        open: b.open,
        fetch: api.fetch,
      })
    ).rejects.toMatchObject({ status: 401 })
    expect(await t.store.load()).toEqual({})
  })

  it('still logs in when /api/me is unavailable (404), with a warning and no user', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const api = mockFetch({})
    const b = browser({ key: TEST_KEY, tenant_id: TENANT_ID })
    const log = createMemoryLogger()
    await loginFlow({ serverUrl: SERVER, store: t.store, log, open: b.open, fetch: api.fetch })
    expect(await t.store.load()).toMatchObject({ apiKey: TEST_KEY, tenantId: TENANT_ID })
    expect(log.lines.join('\n')).toMatch(/Could not load your profile/)
  })

  it('surfaces ?error= from the server and writes nothing', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const b = browser({ error: 'access_denied' })
    await expect(
      loginFlow({
        serverUrl: SERVER,
        store: t.store,
        log: createMemoryLogger(),
        open: b.open,
        fetch: mockFetch({}).fetch,
      })
    ).rejects.toThrow(/access_denied/)
    expect(await t.store.load()).toEqual({})
  })

  it('logout keeps serverUrl and is a no-op when not logged in', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const log = createMemoryLogger()
    await logoutFlow({ store: t.store, log })
    expect(log.lines.join('\n')).toMatch(/Not logged in/)
    await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID })
    await logoutFlow({ store: t.store, log })
    expect(await t.store.load()).toEqual({ serverUrl: SERVER })
  })
})
