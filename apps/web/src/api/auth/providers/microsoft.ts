/**
 * Microsoft Entra ID (D11): arctic `MicrosoftEntraId('common', …)` so personal and work/school
 * accounts both sign in; profile from Graph `/me`. Graph does not expose a verified flag, so
 * `emailVerified` is left undefined (Entra only issues `mail`/`userPrincipalName` it controls).
 */
import { MicrosoftEntraId } from 'arctic'
import { fetchJson, type ProviderDefinition, toTokenSet } from './types'

interface GraphUser {
  id: string
  displayName: string | null
  mail: string | null
  userPrincipalName: string
}

export const microsoftProvider: ProviderDefinition = {
  id: 'microsoft',
  label: 'Microsoft',
  scopes: ['openid', 'profile', 'email', 'User.Read'],
  configured: cfg => Boolean(cfg.MICROSOFT_CLIENT_ID && cfg.MICROSOFT_CLIENT_SECRET),
  client(cfg, redirectUri) {
    const entra = new MicrosoftEntraId(
      'common',
      cfg.MICROSOFT_CLIENT_ID ?? '',
      cfg.MICROSOFT_CLIENT_SECRET ?? '',
      redirectUri
    )
    return {
      createAuthorizationURL: (state, verifier, scopes) =>
        entra.createAuthorizationURL(state, verifier, scopes),
      validateAuthorizationCode: async (code, verifier) =>
        toTokenSet(await entra.validateAuthorizationCode(code, verifier)),
    }
  },
  async fetchProfile(tokens) {
    const me = await fetchJson<GraphUser>(
      'https://graph.microsoft.com/v1.0/me',
      tokens.accessToken,
      'Microsoft profile'
    )
    const email = me.mail ?? me.userPrincipalName
    return {
      providerUserId: me.id,
      email,
      emailVerified: undefined,
      name: me.displayName ?? null,
      avatarUrl: null,
    }
  },
}
