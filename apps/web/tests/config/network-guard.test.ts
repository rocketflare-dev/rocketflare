/** The api suites' network guard: what counts as this machine, and that anything else fails at once. */
import { describe, expect, it } from 'vitest'
import { installNetworkGuard, isLocalUrl, OutboundNetworkError } from '../helpers/network-guard'

describe('network guard', () => {
  it('treats loopback, localhost and the Neon proxy host as local', () => {
    for (const url of [
      'http://127.0.0.1:4433/sql',
      'http://localhost:3001/api',
      'http://[::1]:5433/',
      'https://db.localtest.me:4433/sql',
      '/relative/path',
    ]) {
      expect(isLocalUrl(url), url).toBe(true)
    }
    for (const url of [
      'https://api.anthropic.com/v1/messages',
      'https://api.openai.com/v1/embeddings',
      'https://vendor.example/v1',
      'https://localhost.evil.example/',
    ]) {
      expect(isLocalUrl(url), url).toBe(false)
    }
  })

  it('refuses an outbound request at once, naming the URL', async () => {
    const real = globalThis.fetch
    try {
      installNetworkGuard()
      const started = Date.now()
      await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toBeInstanceOf(
        OutboundNetworkError
      )
      await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
        /outbound network is disabled in tests \(https:\/\/api\.anthropic\.com/
      )
      expect(Date.now() - started).toBeLessThan(100)
    } finally {
      globalThis.fetch = real
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('rocketflare.tests.networkGuard')]
    }
  })
})
