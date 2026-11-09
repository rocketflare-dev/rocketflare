/**
 * Microsoft Entra ID: the `common` endpoint so personal and work/school accounts both sign in;
 * profile from Graph `/me`. Graph does not expose a verified flag, so `emailVerified` is left
 * undefined (Entra only issues `mail`/`userPrincipalName` it controls).
 */
import { ClientSecretBasic, type Configuration, discovery } from 'openid-client'
import type { AppConfig } from '../../../config'
import { DISCOVERY_TTL_MS } from './oidc'
import { openidOAuthClient } from './openid'
import { fetchJson, type ProviderDefinition } from './types'

const ENTRA_COMMON = new URL('https://login.microsoftonline.com/common/v2.0')

// The Configuration itself: discovery marks it multi-tenant with a symbol that cloning drops.
const entraConfigurations = new Map<string, { config: Configuration; fetchedAt: number }>()

async function entraConfiguration(cfg: AppConfig): Promise<Configuration> {
  const clientId = cfg.MICROSOFT_CLIENT_ID ?? ''
  const secret = cfg.MICROSOFT_CLIENT_SECRET ?? ''
  const key = `${clientId}:${secret}`
  const hit = entraConfigurations.get(key)
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.config
  const config = await discovery(ENTRA_COMMON, clientId, undefined, ClientSecretBasic(secret))
  entraConfigurations.set(key, { config, fetchedAt: Date.now() })
  return config
}

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
    return openidOAuthClient(() => entraConfiguration(cfg), redirectUri, { sendsNonce: false })
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
