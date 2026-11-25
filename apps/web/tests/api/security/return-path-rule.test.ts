/**
 * The same-origin path rule shared by the server guard and the SPA: a return path may not contain
 * a control character or a backslash anywhere, and must resolve on the same origin.
 */
import { isSameOriginPath, redirectToSchema } from '@rocketflare/shared/auth'
import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '@/api/routes/auth/helpers'
import { requestMagicLink } from '@/api/routes/auth/magic-link'
import { loadConfig } from '@/config'
import { createTestTenantWithUser } from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const OFF_ORIGIN_PATHS = [
  '/\t/other.example/x',
  '/\t\\other.example/x',
  '/\n/other.example/x',
  '/\r/other.example/x',
  '//other.example/x',
  '/\\other.example/x',
  '/a\\b',
  '/a\u0000b',
  '/a\u007fb',
]

describe('same-origin path rule', () => {
  it.each(OFF_ORIGIN_PATHS)('refuses %j', value => {
    expect(isSameOriginPath(value)).toBe(false)
    expect(redirectToSchema.safeParse(value).success).toBe(false)
    expect(safeRedirectPath(value, '/fallback')).toBe('/fallback')
  })

  it.each([
    '/',
    '/settings/members',
    '/search?q=a%20b#top',
    '/auth/cli?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback',
  ])('accepts %j', value => {
    expect(isSameOriginPath(value)).toBe(true)
    expect(redirectToSchema.safeParse(value).success).toBe(true)
  })

  it('refuses anything that is not a path', () => {
    for (const value of ['', 'settings', 'https://other.example/', 'javascript:alert(1)']) {
      expect(isSameOriginPath(value)).toBe(false)
    }
  })

  it('a magic-link sign-in with a return path holding a tab lands on the app', async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    const env = createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' })
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const { verifyUrl } = await requestMagicLink(db, loadConfig(env), logger, { email: user.email })
    const token = new URL(verifyUrl).searchParams.get('token') as string
    const res = await request(
      '/auth/magic-link/verify',
      {
        method: 'POST',
        body: new URLSearchParams({ token, redirectTo: '/\t/other.example/x' }),
      },
      { env }
    )
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get('location') as string, 'https://app.example').origin).toBe(
      'https://app.example'
    )
  })
})
