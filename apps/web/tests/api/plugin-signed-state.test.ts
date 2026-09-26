/**
 * `signState` / `verifyState` on the plugin surface (D34): round-trip, and `null` for a tampered
 * body or signature, the wrong purpose, an expired token or garbage; a missing
 * `OAUTH_ENCRYPTION_KEY` is a 503 on both sides, never a token signed with nothing. No database.
 *
 * The public MOUNT that consumes them, and `features(tenantId)` on the background contexts, are
 * exercised through the reference plugin (`plugins/example-feature/tests/api`) — both need a flag,
 * and a kit test must not borrow a plugin's — and the prefix rule by `tests/config/plugins.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import { signState, verifyState } from '@/plugins/api'
import { createTestEnv } from '../mocks/bindings'

describe('signState / verifyState', () => {
  const config = loadConfig(createTestEnv())

  it('round-trips the payload for the purpose it was signed for', async () => {
    const token = await signState(config, 'orders:consent', { tenantId: 't1', n: 3 })
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(await verifyState(config, 'orders:consent', token)).toEqual({ tenantId: 't1', n: 3 })
  })

  it('answers null for another purpose, a tampered body or signature, and garbage', async () => {
    const token = await signState(config, 'orders:consent', { tenantId: 't1' })
    const [body = '', sig = ''] = token.split('.')
    const forged = btoa(JSON.stringify({ tenantId: 't2', p: 'orders:consent', exp: 9e9 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(await verifyState(config, 'orders:webhook', token)).toBeNull()
    expect(await verifyState(config, 'orders:consent', `${forged}.${sig}`)).toBeNull()
    expect(await verifyState(config, 'orders:consent', `${body}.${sig.slice(2)}`)).toBeNull()
    expect(await verifyState(config, 'orders:consent', `${token}.extra`)).toBeNull()
    expect(await verifyState(config, 'orders:consent', 'garbage')).toBeNull()
    expect(await verifyState(config, 'orders:consent', '')).toBeNull()
  })

  it('answers null once it has expired', async () => {
    const token = await signState(config, 'orders:consent', { tenantId: 't1' }, { ttlSeconds: -1 })
    expect(await verifyState(config, 'orders:consent', token)).toBeNull()
  })

  it('refuses to sign or verify without OAUTH_ENCRYPTION_KEY', async () => {
    const bare = { ...config, OAUTH_ENCRYPTION_KEY: undefined }
    await expect(signState(bare, 'orders:consent', {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'encryption_key_missing',
    })
    const token = await signState(config, 'orders:consent', {})
    await expect(verifyState(bare, 'orders:consent', token)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it('does not verify under a different key', async () => {
    const token = await signState(config, 'orders:consent', { tenantId: 't1' })
    const other = { ...config, OAUTH_ENCRYPTION_KEY: 'another_key_1111111111111111111111111111' }
    expect(await verifyState(other, 'orders:consent', token)).toBeNull()
  })
})
