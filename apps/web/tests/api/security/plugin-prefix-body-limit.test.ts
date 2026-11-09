// @vitest-isolate
// Mocks the plugin barrel to add a plugin owning a prefix outside `/api`, so it needs its own registry.
/**
 * A plugin route mounted outside `/api` (a protocol endpoint) gets the same request-body cap as
 * everything beneath `/api`: the 1 MB JSON limit, before auth and before any database work.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_JSON_BODY_BYTES } from '@/api/middleware/body-limit'
import { request } from '../../helpers/request'

vi.mock('@/plugins/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/plugins/server')>()
  const { Hono } = await import('hono')
  const router = new Hono()
  router.post('/*', c => c.json({ ok: true }))
  const fixture = {
    shared: { id: 'prefix-fixture', label: 'Prefix fixture' },
    apiPrefixes: ['/x-fixture'],
    mounts: [['/x-fixture', router]],
  }
  const plugins = [...actual.serverPlugins, fixture]
  return { ...actual, SERVER_PLUGINS: plugins, serverPlugins: plugins }
})

const post = (path: string, bytes: number) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(bytes),
  })

describe('the body limit on a plugin prefix outside /api', () => {
  it('a body over the cap is refused beneath the prefix, before auth', async () => {
    const res = await post('/x-fixture/v1/load', MAX_JSON_BODY_BYTES + 1)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: 'payload_too_large' })
  })

  it('a body over the cap is refused at the bare prefix', async () => {
    expect((await post('/x-fixture', MAX_JSON_BODY_BYTES + 1)).status).toBe(413)
  })

  it('a body within the cap reaches the mount', async () => {
    expect((await post('/x-fixture/v1/load', 16)).status).toBe(401)
  })
})
