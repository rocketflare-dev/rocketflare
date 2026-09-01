/**
 * Public invitation routes by token (D9): `GET /api/invite/:token` (details for the accept page —
 * no ids, no other members) and `POST /api/invite/:token/accept` (cookie session required; the
 * UI sends signed-out users to `/login?returnUrl=/invite/<token>`; the email must match). Accept
 * is transactional and answers with the session response so the UI can switch straight in.
 */
import { resolveCookieAuth } from '../middleware/auth'
import { buildSessionResponse } from '../services/auth'
import { acceptInvitation, getInvitationDetails } from '../services/invitations'
import { NotFoundError, UnauthorizedError } from '../utils/core/errors'
import { makeDefer } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const inviteRouter = createRouter()

inviteRouter.get('/:token', async c => {
  const details = await getInvitationDetails(c.get('db'), c.req.param('token'))
  if (!details) throw new NotFoundError('Invitation not found')
  return c.json(details)
})

inviteRouter.post('/:token/accept', async c => {
  const db = c.get('db')
  const cfg = c.get('config')
  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Sign in to accept this invitation')
  await acceptInvitation(db, {
    token: c.req.param('token'),
    user: auth.user,
    sessionId: auth.session.id,
    realtime: { defer: makeDefer(c), env: c.env },
  })
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})
