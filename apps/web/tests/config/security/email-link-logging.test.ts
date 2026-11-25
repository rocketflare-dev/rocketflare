/**
 * With no email provider configured, links are logged so local sign-in keeps working. In
 * production the link is never written to the logs.
 */
import { describe, expect, it, vi } from 'vitest'
import { requestLogPath } from '@/api/middleware/request-logger'
import { sendEmail } from '@/api/services/email'
import { loadConfig } from '@/config'
import { createTestEnv } from '../../mocks/bindings'

const LINK = 'https://app.example/auth/magic-link/verify?token=secret-token-value'
const message = { to: 'a@example.test', subject: 'Sign in', html: '', text: '', link: LINK }

function logged(appEnv: 'production' | 'staging' | 'development') {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const cfg = loadConfig(
    createTestEnv({
      APP_ENV: appEnv,
      APP_URL: 'https://app.example',
      RESEND_API_KEY: '',
    })
  )
  return { logger, cfg, text: () => JSON.stringify(logger.info.mock.calls) }
}

describe('sign-in links in logs', () => {
  it('are not logged in production', async () => {
    const { logger, cfg, text } = logged('production')
    await sendEmail(cfg, logger, message)
    expect(text()).not.toContain('secret-token-value')
    expect(logger.warn).toHaveBeenCalled()
  })

  it.each(['development', 'staging'] as const)('are logged in %s', async appEnv => {
    const { logger, cfg, text } = logged(appEnv)
    await sendEmail(cfg, logger, message)
    expect(text()).toContain('secret-token-value')
  })
})

describe('request log path', () => {
  it.each([
    ['/api/invite/abc123', '/api/invite/[redacted]'],
    ['/api/invite/abc123/accept', '/api/invite/[redacted]/accept'],
    ['/api/invitations/abc', '/api/invitations/abc'],
    ['/api/members', '/api/members'],
  ])('%s logs as %s', (path, expected) => {
    expect(requestLogPath(path)).toBe(expected)
  })
})
