/**
 * Microsoft Entra ID: the `common` endpoint so personal and work/school accounts both sign in;
 * profile from Graph `/me`. The address that matches, links and admits an account is
 * `userPrincipalName`; the separately editable `mail` attribute is not used. With `common` the
 * issuing directory is ANY directory, so the address is trusted (`emailVerified: true`) only when
 * the UPN's domain is one of that directory's verified domains (Graph `/organization`, readable
 * with `User.Read`). A personal Microsoft account (the consumer tenant, where `/organization` is
 * not supported), an unlisted domain, or a failed lookup gives `emailVerified: false`: the person
 * still signs in through a link they made from account settings, but is never matched to an
 * account or admitted by that address.
 */
import { decodeJwt } from 'jose'
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

interface GraphOrganizations {
  value?: { verifiedDomains?: { name?: string }[] }[]
}

/** The consumer (personal Microsoft account) tenant: it has no directory and verifies no domain. */
export const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

function tenantIdOf(idToken: string | null | undefined): string | undefined {
  if (!idToken) return undefined
  try {
    const tid = decodeJwt(idToken).tid
    return typeof tid === 'string' ? tid : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the signed-in person's directory has verified the domain of `principal`. Fails closed:
 * a personal account, an empty answer or any Graph error is `false`, never a thrown sign-in.
 */
async function principalDomainVerified(
  principal: string,
  accessToken: string,
  idToken: string | null | undefined
): Promise<boolean> {
  if (tenantIdOf(idToken) === MSA_TENANT_ID) return false
  const domain = principal.slice(principal.lastIndexOf('@') + 1).toLowerCase()
  if (!domain || !principal.includes('@')) return false
  try {
    const orgs = await fetchJson<GraphOrganizations>(
      'https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains',
      accessToken,
      'Microsoft organization'
    )
    return (orgs.value ?? []).some(org =>
      (org.verifiedDomains ?? []).some(d => d.name?.toLowerCase() === domain)
    )
  } catch {
    return false
  }
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
      emailVerified: await principalDomainVerified(
        me.userPrincipalName,
        tokens.accessToken,
        tokens.idToken
      ),
      name: me.displayName ?? null,
      avatarUrl: null,
    }
  },
}
