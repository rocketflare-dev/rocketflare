/**
 * Generic OpenID Connect (Keycloak, Okta, Entra single-tenant, Auth0, Authentik, Zitadel…): ONE
 * issuer per deployment, configured by `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ optional
 * `OIDC_CLIENT_SECRET`). Everything else comes from the issuer's discovery document.
 *
 * - **Discovery** is fetched from `<issuer>/.well-known/openid-configuration`, cached per isolate for
 *   `DISCOVERY_TTL_MS`, and refused unless its `issuer` equals `OIDC_ISSUER` exactly (OIDC
 *   Discovery §4.3 — the mix-up defence).
 * - **Authorization** is code + PKCE (S256) through arctic's `OAuth2Client`, plus a `nonce` the
 *   router binds to the flow cookie.
 * - **Identity** is the `id_token`, verified with `jose.jwtVerify` against the issuer's JWKS
 *   (`iss`, `aud`, `exp`, `nonce`, `azp` when there are several audiences). The JWKS JSON is cached
 *   per isolate through jose's `jwksCache` hook — plain data, never an in-flight promise shared
 *   across requests — and an unknown `kid` refetches it (key rotation), at most once per 30 s.
 * - **The identity key** is `${iss}|${sub}`: a `sub` is only unique within its issuer, and packing
 *   both into `provider_user_id` needs no migration. Pointing `OIDC_ISSUER` somewhere new therefore
 *   never matches an old link; those users fall back to verified-email linking via `admitUser`.
 * - **`groups`** is read into the profile and deliberately not stored (docs/CONCEPTS.md §2 gaps).
 */
import { CodeChallengeMethod, OAuth2Client } from 'arctic'
import {
  createRemoteJWKSet,
  type JWKSCacheInput,
  type JWTPayload,
  jwksCache,
  jwtVerify,
} from 'jose'
import { z } from 'zod'
import type { AppConfig } from '../../../config'
import { fetchJson, type OAuthProfile, type ProviderDefinition, toTokenSet } from './types'

/** How long a discovery document is trusted before it is fetched again. */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000
/** Clock skew tolerated on `exp` / `iat` / `nbf` between the issuer and the Worker. */
const CLOCK_TOLERANCE_S = 30

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  end_session_endpoint: z.string().url().optional(),
})
export type OidcDiscovery = z.infer<typeof discoverySchema>

interface CachedDiscovery {
  doc: OidcDiscovery
  fetchedAt: number
}

/** Per-isolate caches. Plain JSON only: a Worker must not share an in-flight promise across requests. */
const discoveryCache = new Map<string, CachedDiscovery>()
const jwksCaches = new Map<string, JWKSCacheInput>()

/** Tests only: forget every cached discovery document and key set. */
export function resetOidcCaches(): void {
  discoveryCache.clear()
  jwksCaches.clear()
}

function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
}

/** The issuer's discovery document (cached), or a throw naming what is wrong with it. */
export async function discoverOidc(cfg: AppConfig): Promise<OidcDiscovery> {
  const issuer = cfg.OIDC_ISSUER
  if (!issuer) throw new Error('OIDC_ISSUER is not set')
  const hit = discoveryCache.get(issuer)
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.doc

  const res = await fetch(discoveryUrl(issuer), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const parsed = discoverySchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('OIDC discovery document is missing required endpoints')
  if (parsed.data.issuer !== issuer) {
    throw new Error(
      `OIDC discovery issuer "${parsed.data.issuer}" does not match OIDC_ISSUER "${issuer}"`
    )
  }
  discoveryCache.set(issuer, { doc: parsed.data, fetchedAt: Date.now() })
  return parsed.data
}

function scopesFor(cfg: AppConfig): string[] {
  const scopes = cfg.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean)
  return scopes.includes('openid') ? scopes : ['openid', ...scopes]
}

/** `email_verified` arrives as a boolean, or — from some issuers — the string "true"/"false". */
function verifiedFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Verify an `id_token` for this deployment; returns its claims or throws. */
export async function verifyIdToken(
  cfg: AppConfig,
  doc: OidcDiscovery,
  idToken: string,
  nonce: string | undefined
): Promise<JWTPayload> {
  if (!nonce) throw new Error('OIDC flow has no nonce')
  const clientId = cfg.OIDC_CLIENT_ID ?? ''
  let cache = jwksCaches.get(doc.jwks_uri)
  if (!cache) {
    // jose fills this object in place (`jwks`, `uat`) after each successful fetch.
    cache = {}
    jwksCaches.set(doc.jwks_uri, cache)
  }
  const keys = createRemoteJWKSet(new URL(doc.jwks_uri), { [jwksCache]: cache })
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: doc.issuer,
    audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: CLOCK_TOLERANCE_S,
  })
  if (payload.nonce !== nonce) throw new Error('OIDC id_token nonce mismatch')
  // OIDC Core §3.1.3.7: with several audiences, `azp` must name us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
    throw new Error('OIDC id_token azp does not match the client id')
  }
  return payload
}

interface UserInfo {
  sub: string
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
}

export const oidcProvider: ProviderDefinition = {
  id: 'oidc',
  label: 'Single sign-on',
  scopes: ['openid', 'email', 'profile'],
  scopesFor,
  configured: cfg => Boolean(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID),
  client(cfg, redirectUri) {
    const client = new OAuth2Client(
      cfg.OIDC_CLIENT_ID ?? '',
      cfg.OIDC_CLIENT_SECRET ?? null,
      redirectUri
    )
    return {
      async createAuthorizationURL(state, verifier, scopes, nonce) {
        const doc = await discoverOidc(cfg)
        const url = client.createAuthorizationURLWithPKCE(
          doc.authorization_endpoint,
          state,
          CodeChallengeMethod.S256,
          verifier,
          scopes
        )
        if (nonce) url.searchParams.set('nonce', nonce)
        return url
      },
      async validateAuthorizationCode(code, verifier) {
        const doc = await discoverOidc(cfg)
        return toTokenSet(
          await client.validateAuthorizationCode(doc.token_endpoint, code, verifier)
        )
      },
    }
  },
  fetchProfile: (tokens, { cfg, nonce }) => oidcProfile(cfg, tokens, nonce),
}

/** The profile from a verified `id_token`, topped up from `userinfo` when the token has no email. */
export async function oidcProfile(
  cfg: AppConfig,
  tokens: { accessToken: string; idToken?: string | null },
  nonce: string | undefined
): Promise<OAuthProfile> {
  if (!tokens.idToken) throw new Error('OIDC token response carried no id_token')
  const doc = await discoverOidc(cfg)
  const claims = await verifyIdToken(cfg, doc, tokens.idToken, nonce)
  const sub = claims.sub as string

  let email = stringClaim(claims, 'email')
  let emailVerified = verifiedFlag(claims.email_verified)
  let name = stringClaim(claims, 'name')
  let picture = stringClaim(claims, 'picture')
  if (!email && doc.userinfo_endpoint) {
    const info = await fetchJson<UserInfo>(
      doc.userinfo_endpoint,
      tokens.accessToken,
      'OIDC userinfo'
    )
    // OIDC Core §5.3.2: a userinfo `sub` that differs from the id_token's must not be used.
    if (info.sub !== sub) throw new Error('OIDC userinfo sub does not match the id_token')
    email = info.email
    emailVerified = verifiedFlag(info.email_verified)
    name = name ?? info.name
    picture = picture ?? info.picture
  }
  const given = stringClaim(claims, 'given_name')
  const family = stringClaim(claims, 'family_name')
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : undefined

  return {
    providerUserId: `${doc.issuer}|${sub}`,
    email: email ?? '',
    emailVerified,
    name:
      name ??
      ([given, family].filter(Boolean).join(' ') || stringClaim(claims, 'preferred_username')) ??
      null,
    avatarUrl: picture ?? null,
    groups,
  }
}

/**
 * RP-initiated logout (OIDC RP-Initiated Logout 1.0): the issuer's `end_session_endpoint` with
 * `client_id` and `post_logout_redirect_uri=<APP_URL>/login?signedOut=1`, or null when the issuer
 * advertises none (or discovery fails — logging out locally must never depend on the issuer).
 * No `id_token_hint`: the kit does not keep id_tokens, so the issuer may ask for confirmation.
 */
export async function oidcEndSessionUrl(cfg: AppConfig): Promise<string | null> {
  const doc = await discoverOidc(cfg)
  if (!doc.end_session_endpoint) return null
  const url = new URL(doc.end_session_endpoint)
  url.searchParams.set('client_id', cfg.OIDC_CLIENT_ID ?? '')
  url.searchParams.set(
    'post_logout_redirect_uri',
    new URL('/login?signedOut=1', cfg.APP_URL).toString()
  )
  return url.toString()
}
