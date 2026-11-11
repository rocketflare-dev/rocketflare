/**
 * Sign-in mail is bounded per recipient as well as per client address: past the window's budget
 * the route answers the same 202 and neither mints a token nor sends anything. The window belongs to
 * the MAILBOX: `+tag` spellings of one address, and dotted spellings of a Gmail address, share it.
 */
import { inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { canonicalMailbox } from '@/api/utils/core/mailbox'
import { magicLinkTokens } from '@/db/schema'
import { uniqueId } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const recipient = () => `recipient_${uniqueId().toLowerCase()}@example.test`
const tokens = (...emails: string[]) =>
  db.select().from(magicLinkTokens).where(inArray(magicLinkTokens.email, emails))

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

  it('one mailbox under many +tag spellings shares one window, and each mail goes to the address typed', async () => {
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const local = `recipient_${uniqueId().toLowerCase()}`
    const spellings = Array.from({ length: 12 }, (_, i) => `${local}+${i}@example.test`)
    for (const [i, email] of spellings.entries()) await ask(env, email, `192.0.2.${i + 1}`)
    const minted = await tokens(...spellings)
    expect(minted.length).toBe(5)
    expect(minted.map(t => t.email).sort()).toEqual(spellings.slice(0, 5).sort())
  })

  it('dotted spellings of one Gmail mailbox share one window', async () => {
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const local = `r${uniqueId().toLowerCase().replace(/_/g, '')}`
    const spellings = Array.from({ length: 12 }, (_, i) => {
      const dotted = `${local.slice(0, 1 + (i % 5))}.${local.slice(1 + (i % 5))}`
      return i % 2 ? `${dotted}@gmail.com` : `${dotted}@googlemail.com`
    })
    for (const [i, email] of spellings.entries()) await ask(env, email, `192.0.2.${i + 101}`)
    expect((await tokens(...spellings)).length).toBe(5)
  })
})

describe('canonicalMailbox', () => {
  it.each([
    ['Alice@Example.Test', 'alice@example.test'],
    ['alice+news@example.test', 'alice@example.test'],
    ['a.l.i.c.e@example.test', 'a.l.i.c.e@example.test'],
    ['A.Lice+x@GMail.com', 'alice@gmail.com'],
    ['a.lice@googlemail.com', 'alice@gmail.com'],
    ['+only@example.test', '+only@example.test'],
  ])('%s → %s', (email, mailbox) => {
    expect(canonicalMailbox(email)).toBe(mailbox)
  })
})
