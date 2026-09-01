/**
 * `POST /auth/dev-login` (D11): password-less login for local development ONLY — 404 unless
 * `APP_ENV === 'development'`. Creates or finds the user, bypasses sign-up gating (but not a
 * block), runs `onNoTenant` for a member-less user so single-tenant / open modes behave as a real
 * login would, and answers with the session response + cookie.
 */
import { devLoginRequestSchema } from '@gmgo/shared/auth'
import { eq } from 'drizzle-orm'
import { users } from '../../../db/schema'
import { resolveCookieAuth } from '../../middleware/auth'
import {
  buildSessionResponse,
  findUserByEmail,
  membershipCount,
  nameFromEmail,
  onNoTenant,
} from '../../services/auth'
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../utils/core/errors'
import { createRouter } from '../../utils/routes/router'
import { validate } from '../../utils/routes/validate'
import { completeLogin } from './helpers'

export const devLoginRouter = createRouter()

devLoginRouter.post('/dev-login', validate('json', devLoginRequestSchema), async c => {
  const cfg = c.get('config')
  if (cfg.APP_ENV !== 'development') throw new NotFoundError(`Not found: ${c.req.path}`)
  const db = c.get('db')
  const logger = c.get('logger')
  const { email, name } = c.req.valid('json')

  let user = await findUserByEmail(db, email)
  if (user?.blockedAt) throw new ForbiddenError('Account is blocked', 'blocked')
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({ email, name: name ?? nameFromEmail(email), emailVerifiedAt: new Date() })
      .returning()
    if (!created) throw new Error('dev-login: insert returned no row')
    user = created
  } else if (!user.emailVerifiedAt) {
    const [updated] = await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning()
    user = updated ?? user
  }
  if ((await membershipCount(db, user.id)) === 0) await onNoTenant(db, cfg, user, logger)

  const { token } = await completeLogin(c, db, cfg, user)
  // The cookie is on the RESPONSE; resolve the new session from its token, not the request.
  const auth = await resolveCookieAuth(c, token)
  if (!auth) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, auth))
})
