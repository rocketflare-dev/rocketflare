/**
 * ONE generic OAuth router over the provider registry: `GET /auth/:provider` starts,
 * `GET /auth/:provider/callback` finishes. State + PKCE verifier + OIDC nonce (+ the return path,
 * link mode) travel in a single `oauth_state` cookie that also names the provider, so a callback
 * for the wrong provider is rejected. The return path is `?returnUrl=` (what the UI sends;
 * `?redirectTo=` is still accepted). Redirect URI is `oauthRedirectUri(cfg, provider)`.
 * `email_verified === false` is refused; an existing link wins, then email-based linking to an
 * existing user, else `admitUser`. Tokens are AES-GCM encrypted at rest — `OAUTH_ENCRYPTION_KEY`
 * is checked before the redirect. Unknown or unconfigured provider → 404 envelope; under
 * `AUTH_OIDC_ONLY` every provider but `oidc` → `/login?error=oidc_only`. A token exchange the
 * issuer refuses because its pre-token hook denied the person (Cognito's 400
 * `UserLambdaValidationException`) → `/login?error=no_access`.
 *
 * `OIDC_MANAGED_TENANCY` (`services/idp-tenancy.ts`): after the identity is resolved and BEFORE
 * `completeLogin`, every `oidc` sign-in reconciles tenants, memberships and global admin from the
 * verified id_token's claims — here, not in `admitUser`, because a linked user never reaches
 * `admitUser`. A new person the claims admit is created whatever `SIGNUP_MODE` says, and the
 * session ends `OIDC_SESSION_MAX_AGE_DAYS` after sign-in.
 *
 * SSO required (`ServerPlugin.ssoPolicy`): once the email is known — the verified one the provider
 * asserted AND, for a linked person, their account's — and before anyone is admitted, linked or
 * signed in, a plugin claiming either address sends the browser to
 * `/login?error=sso_required&method=<plugin id>:<method id>`. Link mode (attaching a provider to
 * the signed-in account) is not a sign-in and is not checked.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { randomNonce, randomPKCECodeVerifier, randomState } from 'openid-client'
import { isIdpManaged, isOidcOnly, oauthRedirectUri } from '../../../config'
import {
  clearFlowCookie,
  OAUTH_STATE_COOKIE_NAME,
  readFlowCookie,
  setFlowCookie,
} from '../../auth/cookies'
import { requireEncryptionKey } from '../../auth/oauth-encryption'
import { findProviderLink, upsertProviderLink } from '../../auth/oauth-providers'
import { getProvider, type ProviderDefinition, scopesOf } from '../../auth/providers'
import { isAccessDeniedAtTokenExchange } from '../../auth/providers/oidc'
import { ssoAllows } from '../../auth/sso-policy'
import { resolveCookieAuth } from '../../middleware/auth'
import { admitUser, findUserByEmail } from '../../services/auth'
import { platformFeatures } from '../../services/features'
import { idpClaimsAdmit, readIdpClaims, reconcileIdpClaims } from '../../services/idp-tenancy'
import type { AppContext } from '../../types'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../utils/core/errors'
import { createRouter } from '../../utils/routes/router'
import {
  completeLogin,
  type LoginErrorCode,
  loginErrorRedirect,
  safeRedirectPath,
  ssoRequiredRedirect,
} from './helpers'
import { ssoDecisionFor } from './sso'

export const oauthRouter = createRouter()

interface OAuthFlowState {
  provider: string
  state: string
  verifier: string
  /** OIDC replay defence: sent as `nonce`, must come back inside the verified `id_token`. */
  nonce?: string
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
      nonce: parsed.nonce,
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

/** `AUTH_OIDC_ONLY` hides the other providers on the login page AND refuses them here. */
function refusedByOidcOnly(c: AppContext, def: ProviderDefinition): boolean {
  return isOidcOnly(c.get('config')) && def.id !== 'oidc'
}

oauthRouter.get('/:provider', async c => {
  const cfg = c.get('config')
  const def = requireConfiguredProvider(c)
  if (refusedByOidcOnly(c, def)) return loginErrorRedirect(c, 'oidc_only')
  requireEncryptionKey(cfg)

  let linkUserId: string | undefined
  if (c.req.query('link') === '1' || c.req.query('link') === 'true') {
    const auth = await resolveCookieAuth(c)
    if (!auth) throw new UnauthorizedError('Sign in before linking a provider')
    linkUserId = auth.user.id
  }

  const state = randomState()
  const verifier = randomPKCECodeVerifier()
  const nonce = randomNonce()
  const client = def.client(cfg, oauthRedirectUri(cfg, def.id))
  let url: URL
  try {
    url = await client.createAuthorizationURL(state, verifier, scopesOf(def, cfg), nonce)
  } catch (err) {
    // Discovery (OIDC, Microsoft) is the only thing here that can fail (issuer down, mismatch).
    c.get('logger').warn({ err, provider: def.id }, 'OAuth authorization URL failed')
    return loginErrorRedirect(c, 'oauth_failed')
  }
  const returnPath = c.req.query('returnUrl') ?? c.req.query('redirectTo')
  setFlowCookie(
    c,
    cfg,
    OAUTH_STATE_COOKIE_NAME,
    encodeFlow({
      provider: def.id,
      state,
      verifier,
      nonce,
      redirectTo: safeRedirectPath(returnPath, linkUserId ? '/settings' : '/'),
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
  if (refusedByOidcOnly(c, def)) return loginErrorRedirect(c, 'oidc_only')

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
    tokens = await client.validateAuthorizationCode(new URL(c.req.url).searchParams, {
      state,
      verifier: flow.verifier,
      nonce: flow.nonce,
    })
    profile = await def.fetchProfile(tokens, { cfg, nonce: flow.nonce })
  } catch (err) {
    if (def.id === 'oidc' && (await isAccessDeniedAtTokenExchange(err))) {
      logger.info({ provider: def.id }, 'OIDC issuer denied the token exchange: no access')
      return loginErrorRedirect(c, 'no_access')
    }
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
      await upsertProviderLink(db, cfg, auth.user.id, def.id, profile, tokens, scopesOf(def, cfg))
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

  // SSO required: before admitUser, so a refused person leaves no row and no access request.
  const sso = await ssoDecisionFor(db, cfg, [email, user?.email], logger)
  if (!ssoAllows(sso, 'core')) return ssoRequiredRedirect(c, sso, { returnUrl: flow.redirectTo })

  // IdP-managed tenancy: verified claims, or null (absent/malformed → ignored, logged).
  const managed = def.id === 'oidc' && isIdpManaged(cfg)
  const claims = managed ? readIdpClaims(cfg, profile.idTokenClaims, logger) : null

  // 2. Else by verified email (existing user is linked; a new one goes through sign-up gating —
  //    or, under IdP-managed tenancy, is admitted by the claims).
  if (!user) {
    const admitted = await admitUser(
      db,
      cfg,
      {
        email,
        name: profile.name,
        verified: true,
        avatarUrl: profile.avatarUrl,
        admittedBy: claims && idpClaimsAdmit(claims) ? 'idp' : undefined,
      },
      logger
    )
    if (!admitted.ok) return loginErrorRedirect(c, admitted.reason as LoginErrorCode)
    user = admitted.user
  } else if (!user.emailVerifiedAt) {
    user = (await findUserByEmail(db, user.email)) ?? user
  }

  try {
    await upsertProviderLink(db, cfg, user.id, def.id, profile, tokens, scopesOf(def, cfg))
  } catch (err) {
    if (err instanceof ConflictError) return loginErrorRedirect(c, 'provider_linked_elsewhere')
    throw err
  }

  if (claims) {
    try {
      const reconciled = await reconcileIdpClaims(
        db,
        user,
        claims,
        logger,
        await platformFeatures(db, cfg)
      )
      user = reconciled.user
    } catch (err) {
      // Never sign someone in on memberships the claims were about to change.
      logger.error({ err, userId: user.id }, 'IdP-managed tenancy: reconcile failed')
      return loginErrorRedirect(c, 'oauth_failed')
    }
  }

  await completeLogin(c, db, cfg, user, null)
  return c.redirect(flow.redirectTo, 302)
})
