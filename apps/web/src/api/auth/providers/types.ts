/**
 * The provider contract (D11): one generic `/auth/:provider` router drives every entry in the
 * registry, so adding GitHub or Slack is one file here, not a copied route. `emailVerified` is
 * part of the profile on purpose — the router refuses to link when it is explicitly `false`.
 */
import type { OAuthProviderName } from '@rocketflare/shared/auth'
import type { AppConfig } from '../../../config'

export interface OAuthProfile {
  /** The provider's stable subject id (`sub`), never the email. */
  providerUserId: string
  email: string
  /** `undefined` = the provider did not say; only an explicit `false` is refused. */
  emailVerified?: boolean
  name: string | null
  avatarUrl: string | null
  /** Group names the issuer asserted (OIDC `groups`). Read, never stored — a known gap. */
  groups?: string[]
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  /** The OIDC `id_token`, when the token response carried one. Never stored. */
  idToken?: string | null
}

/** The subset of an arctic client the router needs — so tests can substitute a stub. */
export interface OAuthClient {
  /** `nonce` is sent by providers that verify an `id_token` (OIDC); the others ignore it. */
  createAuthorizationURL(
    state: string,
    codeVerifier: string,
    scopes: string[],
    nonce?: string
  ): URL | Promise<URL>
  validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuthTokenSet>
}

/** What the callback knows beyond the tokens — the config, and the nonce bound to the flow. */
export interface ProfileContext {
  cfg: AppConfig
  nonce?: string
}

export interface ProviderDefinition {
  id: OAuthProviderName
  label: string
  scopes: string[]
  /** The credentials it needs are present (client id + secret; OIDC: issuer + client id). */
  configured(cfg: AppConfig): boolean
  client(cfg: AppConfig, redirectUri: string): OAuthClient
  /** Scopes for THIS deployment when they are configurable (OIDC); else `scopes`. */
  scopesFor?(cfg: AppConfig): string[]
  fetchProfile(tokens: OAuthTokenSet, ctx: ProfileContext): Promise<OAuthProfile>
}

/** arctic's `OAuth2Tokens` → our plain token set (methods throw when a field is absent). */
export function toTokenSet(tokens: {
  accessToken(): string
  hasRefreshToken(): boolean
  refreshToken(): string
  accessTokenExpiresAt(): Date
  idToken?(): string
}): OAuthTokenSet {
  let expiresAt: Date | null = null
  try {
    expiresAt = tokens.accessTokenExpiresAt()
  } catch {
    expiresAt = null
  }
  let idToken: string | null = null
  try {
    idToken = tokens.idToken?.() ?? null
  } catch {
    idToken = null
  }
  return {
    accessToken: tokens.accessToken(),
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    expiresAt,
    idToken,
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
