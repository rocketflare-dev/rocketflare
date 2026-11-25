/**
 * The example plugin's `ssoPolicy` (`api/sso.ts`): `@sso-required.example.test` must sign in
 * through the example SSO, development only. Proves the slot end to end on the REAL barrel — the
 * kit refuses its own methods for the domain and lets this plugin's `signIn` through. The other
 * enforcement points, the throwing policy and the break-glass are the kit's to prove, with
 * fixtures, in `tests/api/auth-sso-required.test.ts`.
 */
import { createTestUser, json, request, setupTestDatabase, uniqueId } from '@testkit/integration'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { allTables } from '@/plugins/api/peers'

const db = setupTestDatabase()

const HOOKS = '/api/hooks/example-feature/sso'
const METHOD = 'example-feature:demo-sso'
const requiredEmail = () => `sso_${uniqueId().toLowerCase()}@sso-required.example.test`

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'http://localhost')
}

describe('example ssoPolicy', () => {
  it('the magic-link request mints no token for the domain, and still answers 202', async () => {
    const email = requiredEmail()
    const res = await request('/auth/magic-link/request', { method: 'POST' }, { json: { email } })
    expect(res.status).toBe(202)
    const { magicLinkTokens } = allTables()
    expect(
      await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))
    ).toHaveLength(0)
  })

  it('dev login is refused with the example SSO as the method', async () => {
    const res = await request(
      '/auth/dev-login',
      { method: 'POST' },
      { json: { email: requiredEmail() } }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'sso_required', details: { method: METHOD } })
  })

  it('the example SSO — the claiming plugin — signs the same address in', async () => {
    const email = requiredEmail()
    await createTestUser(db, { email })
    const start = await request(`${HOOKS}/start?${new URLSearchParams({ email })}`)
    const callback = location(start)
    const res = await request(`${callback.pathname}${callback.search}`)
    expect(res.status).toBe(302)
    expect(location(res).pathname).toBe('/')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__Host-session=[^;]+;/)
  })
})
