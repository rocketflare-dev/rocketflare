/**
 * Google: code + PKCE against its fixed endpoints (no discovery); profile from the OIDC userinfo
 * endpoint, which carries `email_verified`.
 */
import { ClientSecretBasic, Configuration, type ServerMetadata } from 'openid-client'
import { openidOAuthClient } from './openid'
import { fetchJson, type ProviderDefinition } from './types'

const GOOGLE: ServerMetadata = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
}

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
    const configuration = async () =>
      new Configuration(
        GOOGLE,
        cfg.GOOGLE_CLIENT_ID ?? '',
        undefined,
        ClientSecretBasic(cfg.GOOGLE_CLIENT_SECRET ?? '')
      )
    return openidOAuthClient(configuration, redirectUri, { sendsNonce: false })
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
