/**
 * The SPA catch-all under `not_found_handling = "none"`: ASSETS answers a client route with a 404,
 * and the catch-all fetches the shell for a navigation and for nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import { request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const SHELL = '<!doctype html>'
const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' }

function envWithAssets() {
  const fetch = vi.fn(async (input: Request) => {
    const { pathname } = new URL(input.url)
    return pathname === '/'
      ? new Response(SHELL, { headers: { 'Content-Type': 'text/html' } })
      : new Response('missing', { status: 404 })
  })
  const env = createTestEnv()
  env.ASSETS = { fetch } as unknown as typeof env.ASSETS
  return { env, fetch }
}

describe('the SPA catch-all with not_found_handling none', () => {
  it('serves the shell for a navigation to a client route', async () => {
    const { env, fetch } = envWithAssets()
    const res = await request('/settings', { headers: NAVIGATE }, { env })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SHELL)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new URL(fetch.mock.calls[1][0].url).pathname).toBe('/')
  })

  it('counts Accept: text/html as a navigation, for a browser with no Sec-Fetch-Mode', async () => {
    const { env } = envWithAssets()
    const res = await request('/settings', { headers: { Accept: 'text/html' } }, { env })
    expect(await res.text()).toBe(SHELL)
  })

  it('leaves a non-navigation 404 alone', async () => {
    const { env, fetch } = envWithAssets()
    const res = await request('/settings', { headers: { Accept: '*/*' } }, { env })
    expect(res.status).toBe(404)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    '/robots.txt',
    '/favicon.ico',
    '/assets/missing.js',
    '/assets',
    '/site-assets/missing.css',
    '/site-assets',
  ])('%s is never the shell, even for a navigation', async path => {
    const { env, fetch } = envWithAssets()
    const res = await request(path, { headers: NAVIGATE }, { env })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('missing')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an unsafe method is not a navigation', async () => {
    const { env, fetch } = envWithAssets()
    const res = await request('/settings', { method: 'POST', headers: NAVIGATE }, { env })
    expect(res.status).not.toBe(200)
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('an API-shaped path stays a JSON 404 and never reaches ASSETS', async () => {
    const { env, fetch } = envWithAssets()
    const res = await request('/api/nope', { headers: NAVIGATE }, { env })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a hit is returned as it is', async () => {
    const { env, fetch } = envWithAssets()
    const res = await request('/', { headers: NAVIGATE }, { env })
    expect(await res.text()).toBe(SHELL)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
