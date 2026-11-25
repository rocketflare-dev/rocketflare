/** The `OAuthClient` every provider hands the router: code + PKCE (S256) via `openid-client`. */
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  type Configuration,
  calculatePKCECodeChallenge,
  type TokenEndpointResponse,
} from 'openid-client'
import type { OAuthClient, OAuthTokenSet } from './types'

export function openidOAuthClient(
  configuration: () => Promise<Configuration>,
  redirectUri: string,
  { sendsNonce }: { sendsNonce: boolean }
): OAuthClient {
  return {
    async createAuthorizationURL(state, verifier, scopes, nonce) {
      const params: Record<string, string> = {
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        state,
        code_challenge: await calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }
      if (sendsNonce && nonce) params.nonce = nonce
      return buildAuthorizationUrl(await configuration(), params)
    },
    async validateAuthorizationCode(callbackParams, checks) {
      // The library sends this URL, minus its query, as `redirect_uri`: never the request's own.
      const currentUrl = new URL(redirectUri)
      for (const [key, value] of callbackParams) currentUrl.searchParams.append(key, value)
      const tokens = await authorizationCodeGrant(await configuration(), currentUrl, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        ...(sendsNonce && checks.nonce ? { expectedNonce: checks.nonce } : {}),
      })
      return tokenSetOf(tokens)
    },
  }
}

function tokenSetOf(tokens: TokenEndpointResponse): OAuthTokenSet {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt:
      tokens.expires_in === undefined ? null : new Date(Date.now() + tokens.expires_in * 1000),
    idToken: tokens.id_token ?? null,
  }
}
