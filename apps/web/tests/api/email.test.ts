// @vitest-isolate
// Spies on the global fetch, so this file needs its own module registry.
/**
 * Email service (D16 zero-creds): no RESEND_API_KEY → logged (with the link), nothing sent; with a
 * key → one POST to Resend with the Bearer header; a Resend error is reported, never thrown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accessRequestDecidedEmail,
  invitationEmail,
  magicLinkEmail,
  sendEmail,
} from '@/api/services/email'
import { loadConfig } from '@/config'
import { createTestEnv } from '../mocks/bindings'

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sendEmail', () => {
  it('without a key: logs To/Subject/Link at info and returns delivered: false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const cfg = loadConfig(createTestEnv({ RESEND_API_KEY: '' }))
    const log = logger()
    const result = await sendEmail(
      cfg,
      log,
      magicLinkEmail(
        cfg,
        'a@example.test',
        'http://localhost:3001/auth/magic-link/verify?token=abc'
      )
    )
    expect(result).toEqual({ delivered: false })
    expect(fetchSpy).not.toHaveBeenCalled()
    const lines = log.info.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(lines).toContain(
      '[email:dev] To: a@example.test Subject: Sign in to Rocketflare Test Link: http://localhost:3001/auth/magic-link/verify?token=abc'
    )
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('with a key: POSTs to Resend with Authorization: Bearer and the configured from', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }))
    const cfg = loadConfig(createTestEnv({ RESEND_API_KEY: 're_test_123' }))
    const msg = invitationEmail(cfg, 'b@example.test', {
      tenantName: 'Acme',
      inviterName: 'Olivia',
      role: 'admin',
      acceptUrl: 'http://localhost:3001/invite/tok',
    })
    const result = await sendEmail(cfg, logger(), msg)
    expect(result).toEqual({ delivered: true, id: 'msg_1' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_123')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      from: cfg.EMAIL_FROM,
      to: 'b@example.test',
      subject: "You've been invited to Acme",
    })
    expect(body.html).toContain('http://localhost:3001/invite/tok')
    expect(body.text).toContain('Olivia invited you to join Acme')
  })

  it('a Resend failure is returned, not thrown, and logged at error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    const cfg = loadConfig(createTestEnv({ RESEND_API_KEY: 're_test_123' }))
    const log = logger()
    const result = await sendEmail(
      cfg,
      log,
      accessRequestDecidedEmail(cfg, 'c@example.test', { approved: true, tenantName: 'Acme' })
    )
    expect(result).toMatchObject({ delivered: false, error: 'Resend 500' })
    expect(log.error).toHaveBeenCalled()
  })

  it('templates escape user content and are branded by APP_NAME', () => {
    const cfg = loadConfig(createTestEnv({ APP_NAME: 'Brand<Co>' }))
    const msg = invitationEmail(cfg, 'x@example.test', {
      tenantName: '<script>alert(1)</script>',
      inviterName: 'A & B',
      role: 'member',
      acceptUrl: 'http://x/invite/t',
    })
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;script&gt;')
    expect(msg.html).toContain('Brand&lt;Co&gt;')
    expect(msg.subject).toContain('<script>') // subject is plain text, escaped by the mail client
  })
})
