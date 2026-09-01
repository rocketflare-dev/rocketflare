/**
 * Google (D11): arctic `Google` with PKCE; profile from the OIDC userinfo endpoint, which
 * carries `email_verified`.
 */
import { Google } from 'arctic'
import { fetchJson, type ProviderDefinition, toTokenSet } from './types'

interface GoogleUserInfo {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  picture?: string
}

export const googleProvider: ProviderDefinition = {
  id: 'google',
  label: 'Google',
  scopes: ['openid', 'email', 'profile'],
  configured: cfg => Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET),
  client(cfg, redirectUri) {
    const google = new Google(
      cfg.GOOGLE_CLIENT_ID ?? '',
      cfg.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri
    )
    return {
      createAuthorizationURL: (state, verifier, scopes) =>
        google.createAuthorizationURL(state, verifier, scopes),
      validateAuthorizationCode: async (code, verifier) =>
        toTokenSet(await google.validateAuthorizationCode(code, verifier)),
    }
  },
  async fetchProfile(tokens) {
    const info = await fetchJson<GoogleUserInfo>(
      'https://openidconnect.googleapis.com/v1/userinfo',
      tokens.accessToken,
      'Google profile'
    )
    return {
      providerUserId: info.sub,
      email: info.email,
      emailVerified: info.email_verified,
      name: info.name ?? null,
      avatarUrl: info.picture ?? null,
    }
  },
}
