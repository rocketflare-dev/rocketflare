/**
 * Sign-in mail is bounded per recipient as well as per client address: past the window's budget
 * the route answers the same 202 and neither mints a token nor sends anything.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { magicLinkTokens } from '@/db/schema'
import { uniqueId } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const recipient = () => `recipient_${uniqueId().toLowerCase()}@example.test`
const tokens = (email: string) =>
  db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))

const ask = (env: ReturnType<typeof createTestEnv>, email: string, ip: string) =>
  request(
    '/auth/magic-link/request',
    { method: 'POST', headers: { 'cf-connecting-ip': ip } },
    { env, json: { email } }
  )

describe('per-recipient sign-in mail window', () => {
  it('stops minting for one address across many client addresses, answering 202 throughout', async () => {
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const email = recipient()
    for (let i = 1; i <= 12; i++) {
      const res = await ask(env, email, `2001:db8:1:1::${i.toString(16)}`)
      expect(res.status).toBe(202)
      expect(await json(res)).toEqual({ ok: true })
    }
    const minted = await tokens(email)
    expect(minted.length).toBeGreaterThan(0)
    expect(minted.length).toBeLessThan(12)
  })

  it('another recipient keeps its own window', async () => {
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const first = recipient()
    for (let i = 0; i < 12; i++) await ask(env, first, `198.51.100.${i + 1}`)
    const second = recipient()
    await ask(env, second, '198.51.100.200')
    expect(await tokens(second)).toHaveLength(1)
  })

  it('treats the address case-insensitively', async () => {
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const email = recipient()
    for (let i = 0; i < 12; i++) {
      await ask(env, i % 2 ? email : email.toUpperCase(), `203.0.113.${i + 1}`)
    }
    expect((await tokens(email)).length).toBeLessThan(12)
  })
})
