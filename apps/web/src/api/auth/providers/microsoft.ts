/**
 * Microsoft Entra ID: the `common` endpoint so personal and work/school accounts both sign in;
 * profile from Graph `/me`. The address that matches, links and admits an account is
 * `userPrincipalName`, whose domain Entra requires the directory to have verified; the separately
 * editable `mail` attribute is not used. Graph exposes no verified flag, so `emailVerified` is
 * left undefined.
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
    return {
      providerUserId: me.id,
      email: me.userPrincipalName,
      emailVerified: undefined,
      name: me.displayName ?? null,
      avatarUrl: null,
    }
  },
}
