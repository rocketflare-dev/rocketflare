/**
 * ONE generic OAuth router over the provider registry (D11, D12): `GET /auth/:provider` starts,
 * `GET /auth/:provider/callback` finishes. State + PKCE verifier (+ redirectTo, link mode) travel in
 * a single `oauth_state` cookie that also names the provider, so a callback for the wrong provider
 * is rejected. Redirect URI is `oauthRedirectUri(cfg, provider)`. `email_verified === false` is
 * refused; an existing link wins, then email-based linking to an existing user, else `admitUser`.
 * Tokens are AES-GCM encrypted at rest — `OAUTH_ENCRYPTION_KEY` is checked before the redirect.
 * Unknown or unconfigured provider → 404 envelope.
 */
import { ERROR_CODES } from '@gmgo/shared/errors'
import { generateCodeVerifier, generateState } from 'arctic'
import { oauthRedirectUri } from '../../../config'
import {
  clearFlowCookie,
  OAUTH_STATE_COOKIE_NAME,
  readFlowCookie,
  setFlowCookie,
} from '../../auth/cookies'
import { requireEncryptionKey } from '../../auth/oauth-encryption'
import { findProviderLink, upsertProviderLink } from '../../auth/oauth-providers'
import { getProvider, type ProviderDefinition } from '../../auth/providers'
import { resolveCookieAuth } from '../../middleware/auth'
import { admitUser, findUserByEmail } from '../../services/auth'
import type { AppContext } from '../../types'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../utils/core/errors'
import { createRouter } from '../../utils/routes/router'
import { completeLogin, type LoginErrorCode, loginErrorRedirect, safeRedirectPath } from './helpers'

export const oauthRouter = createRouter()

interface OAuthFlowState {
  provider: string
  state: string
  verifier: string
  redirectTo: string
  /** Link mode: attach the provider to THIS signed-in user instead of logging in. */
  linkUserId?: string
}

function encodeFlow(flow: OAuthFlowState): string {
  return btoa(JSON.stringify(flow)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeFlow(value: string | undefined): OAuthFlowState | null {
  if (!value) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(atob(padded)) as Partial<OAuthFlowState>
    if (!parsed.provider || !parsed.state || !parsed.verifier) return null
    return {
      provider: parsed.provider,
      state: parsed.state,
      verifier: parsed.verifier,
      redirectTo: parsed.redirectTo ?? '/',
      linkUserId: parsed.linkUserId,
    }
  } catch {
    return null
  }
}

function requireConfiguredProvider(c: AppContext): ProviderDefinition {
  const def = getProvider(c.req.param('provider') ?? '')
  if (!def?.configured(c.get('config'))) {
    throw new NotFoundError('Unknown or unconfigured provider', ERROR_CODES.notFound)
  }
  return def
}

oauthRouter.get('/:provider', async c => {
  const cfg = c.get('config')
  const def = requireConfiguredProvider(c)
  requireEncryptionKey(cfg)

  let linkUserId: string | undefined
  if (c.req.query('link') === '1' || c.req.query('link') === 'true') {
    const auth = await resolveCookieAuth(c)
    if (!auth) throw new UnauthorizedError('Sign in before linking a provider')
    linkUserId = auth.user.id
  }

  const state = generateState()
  const verifier = generateCodeVerifier()
  const client = def.client(cfg, oauthRedirectUri(cfg, def.id))
  const url = client.createAuthorizationURL(state, verifier, def.scopes)
  setFlowCookie(
    c,
    cfg,
    OAUTH_STATE_COOKIE_NAME,
    encodeFlow({
      provider: def.id,
      state,
      verifier,
      redirectTo: safeRedirectPath(c.req.query('redirectTo'), linkUserId ? '/settings' : '/'),
      linkUserId,
    })
  )
  return c.redirect(url.toString(), 302)
})

oauthRouter.get('/:provider/callback', async c => {
  const cfg = c.get('config')
  const db = c.get('db')
  const logger = c.get('logger')
  const def = requireConfiguredProvider(c)

  const flow = decodeFlow(readFlowCookie(c, OAUTH_STATE_COOKIE_NAME))
  clearFlowCookie(c, cfg, OAUTH_STATE_COOKIE_NAME)
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (c.req.query('error')) {
    logger.warn(
      { provider: def.id, error: c.req.query('error') },
      'OAuth provider returned an error'
    )
    return loginErrorRedirect(c, 'oauth_failed')
  }
  if (!flow || flow.provider !== def.id || !code || !state || state !== flow.state) {
    return loginErrorRedirect(c, 'oauth_state_mismatch')
  }

  let profile: Awaited<ReturnType<ProviderDefinition['fetchProfile']>>
  let tokens: Awaited<
    ReturnType<ReturnType<ProviderDefinition['client']>['validateAuthorizationCode']>
  >
  try {
    const client = def.client(cfg, oauthRedirectUri(cfg, def.id))
    tokens = await client.validateAuthorizationCode(code, flow.verifier)
    profile = await def.fetchProfile(tokens)
  } catch (err) {
    logger.warn({ err, provider: def.id }, 'OAuth code exchange or profile fetch failed')
    return loginErrorRedirect(c, 'oauth_failed')
  }
  if (profile.emailVerified === false || !profile.email) {
    return loginErrorRedirect(c, 'email_unverified')
  }
  const email = profile.email.toLowerCase()

  // Link mode: attach to the signed-in user (must still be signed in).
  if (flow.linkUserId) {
    const auth = await resolveCookieAuth(c)
    if (!auth || auth.user.id !== flow.linkUserId)
      throw new UnauthorizedError('Sign in before linking a provider')
    try {
      await upsertProviderLink(db, cfg, auth.user.id, def.id, profile, tokens, def.scopes)
    } catch (err) {
      if (err instanceof ConflictError) return loginErrorRedirect(c, 'provider_linked_elsewhere')
      throw err
    }
    return c.redirect(flow.redirectTo, 302)
  }

  // 1. Existing link for this provider identity → that user.
  const link = await findProviderLink(db, def.id, profile.providerUserId)
  let user = link
    ? await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, link.userId) })
    : undefined
  if (user?.blockedAt) return loginErrorRedirect(c, 'blocked')

  // 2. Else by verified email (existing user is linked; a new one goes through sign-up gating).
  if (!user) {
    const admitted = await admitUser(
      db,
      cfg,
      { email, name: profile.name, verified: true, avatarUrl: profile.avatarUrl },
      logger
    )
    if (!admitted.ok) return loginErrorRedirect(c, admitted.reason as LoginErrorCode)
    user = admitted.user
  } else if (!user.emailVerifiedAt) {
    user = (await findUserByEmail(db, user.email)) ?? user
  }

  try {
    await upsertProviderLink(db, cfg, user.id, def.id, profile, tokens, def.scopes)
  } catch (err) {
    if (err instanceof ConflictError) return loginErrorRedirect(c, 'provider_linked_elsewhere')
    throw err
  }

  await completeLogin(c, db, cfg, user)
  return c.redirect(flow.redirectTo, 302)
})
