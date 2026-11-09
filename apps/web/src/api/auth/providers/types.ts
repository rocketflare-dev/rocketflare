/**
 * The provider contract: one generic `/auth/:provider` router drives every entry in the
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
  /**
   * The VERIFIED id_token's payload (OIDC only) — what IdP-managed tenancy reads its claims from
   * (`OIDC_MANAGED_TENANCY`). Never stored.
   */
  idTokenClaims?: Record<string, unknown>
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  /** The OIDC `id_token`, when the token response carried one. Never stored. */
  idToken?: string | null
}

/** What the callback checks the code exchange against: the values bound to the flow cookie. */
export interface CodeExchangeChecks {
  state: string
  verifier: string
  nonce?: string
}

/** The client the router needs (`openid.ts`) — so tests can substitute a stub. */
export interface OAuthClient {
  /** `nonce` is sent by providers that verify an `id_token` (OIDC); the others ignore it. */
  createAuthorizationURL(
    state: string,
    codeVerifier: string,
    scopes: string[],
    nonce?: string
  ): URL | Promise<URL>
  /** `callbackParams` is the callback's whole query: `code`, `state`, and `iss` where sent. */
  validateAuthorizationCode(
    callbackParams: URLSearchParams,
    checks: CodeExchangeChecks
  ): Promise<OAuthTokenSet>
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

export async function fetchJson<T>(url: string, accessToken: string, what: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${what}: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}
