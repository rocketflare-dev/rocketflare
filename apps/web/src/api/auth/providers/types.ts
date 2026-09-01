/**
 * The provider contract (D11): one generic `/auth/:provider` router drives every entry in the
 * registry, so adding GitHub or Slack is one file here, not a copied route. `emailVerified` is
 * part of the profile on purpose — the router refuses to link when it is explicitly `false`.
 */
import type { OAuthProviderName } from '@gmgo/shared/auth'
import type { AppConfig } from '../../../config'

export interface OAuthProfile {
  /** The provider's stable subject id (`sub`), never the email. */
  providerUserId: string
  email: string
  /** `undefined` = the provider did not say; only an explicit `false` is refused. */
  emailVerified?: boolean
  name: string | null
  avatarUrl: string | null
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
}

/** The subset of an arctic client the router needs — so tests can substitute a stub. */
export interface OAuthClient {
  createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]): URL
  validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuthTokenSet>
}

export interface ProviderDefinition {
  id: OAuthProviderName
  label: string
  scopes: string[]
  /** Both client id and secret present. */
  configured(cfg: AppConfig): boolean
  client(cfg: AppConfig, redirectUri: string): OAuthClient
  fetchProfile(tokens: OAuthTokenSet): Promise<OAuthProfile>
}

/** arctic's `OAuth2Tokens` → our plain token set (methods throw when a field is absent). */
export function toTokenSet(tokens: {
  accessToken(): string
  hasRefreshToken(): boolean
  refreshToken(): string
  accessTokenExpiresAt(): Date
}): OAuthTokenSet {
  let expiresAt: Date | null = null
  try {
    expiresAt = tokens.accessTokenExpiresAt()
  } catch {
    expiresAt = null
  }
  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    expiresAt,
  }
}

export async function fetchJson<T>(url: string, accessToken: string, what: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${what}: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}
