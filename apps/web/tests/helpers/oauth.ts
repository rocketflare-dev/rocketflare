/**
 * OAuth fixtures for the authorization server: a client already in the metadata-document cache
 * (so no test fetches a document — `tests/config/mcp-cimd.test.ts` covers the fetch itself), a
 * PKCE pair, and the browser half of a connection driven through the real routes: authorize →
 * continue → consent → the client's redirect with a code → the token endpoint.
 *
 * Every browser step carries its own `cf-connecting-ip`, so the per-IP login-shaped rate limit
 * never trips across a file's tests.
 */
import { createHash, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import type { Database } from '@/db/client'
import { oauthClients } from '@/db/schema'
import type { TestEnv } from '../mocks/bindings'
import { sessionCookieHeader } from './auth'
import { request } from './request'

export const CLAUDE_LIKE_CLIENT = 'https://client.example.com/oauth/metadata.json'
export const CLAUDE_LIKE_REDIRECT = 'https://client.example.com/api/callback'
export const LOOPBACK_CLIENT = 'https://cli.example.com/oauth/client.json'
export const LOOPBACK_REDIRECT = 'http://127.0.0.1:33418/callback'

const b64url = (buf: Buffer) => buf.toString('base64url')

export function pkcePair() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** A client whose document is cached and fresh — what a first authorize would have written. */
export async function seedOAuthClient(
  db: Database,
  input: {
    clientId?: string
    redirectUris?: string[]
    name?: string
    fetchedAt?: Date
  } = {}
) {
  const clientId = input.clientId ?? CLAUDE_LIKE_CLIENT
  const values = {
    clientName: input.name ?? 'Example Client',
    redirectUris: input.redirectUris ?? [CLAUDE_LIKE_REDIRECT],
    logoUri: null,
    clientUri: null,
    fetchedAt: input.fetchedAt ?? new Date(),
  }
  await db
    .insert(oauthClients)
    .values({ clientId, ...values })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
  return clientId
}

let ipCounter = 0
/** A fresh client IP — each test's browser steps get their own login-shaped rate-limit bucket. */
export function freshIp(): string {
  ipCounter += 1
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`
}

export interface AuthorizeParams {
  client_id?: string
  redirect_uri?: string
  response_type?: string
  code_challenge?: string
  code_challenge_method?: string
  resource?: string
  scope?: string
  state?: string
}

export function authorizePath(params: AuthorizeParams): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  return `/oauth/authorize?${q}`
}

/** Sensible defaults for a valid request from the seeded client to `/mcp`. */
export function validAuthorize(
  env: TestEnv,
  overrides: AuthorizeParams & { challenge?: string } = {}
): AuthorizeParams {
  const origin = new URL(env.APP_URL as string).origin
  return {
    client_id: CLAUDE_LIKE_CLIENT,
    redirect_uri: CLAUDE_LIKE_REDIRECT,
    response_type: 'code',
    code_challenge: overrides.challenge ?? pkcePair().challenge,
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
    scope: 'mcp:read',
    state: 'st-123',
    ...overrides,
  }
}

/** GET with an optional session cookie and a fresh IP. */
export function browserGet(env: TestEnv, path: string, cookie?: string, ip = freshIp()) {
  return request(
    path,
    { headers: { 'cf-connecting-ip': ip, ...(cookie ? sessionCookieHeader(cookie) : {}) } },
    { env }
  )
}

/** The pending request id from a `/consent?request=<id>` (or `/oauth/continue?request=`) URL. */
export function requestIdFrom(location: string | null): string {
  const url = new URL(location ?? '', 'http://x')
  const id =
    url.searchParams.get('request') ??
    new URLSearchParams(
      decodeURIComponent(url.searchParams.get('returnUrl') ?? '').split('?')[1]
    ).get('request')
  expect(id, `no request id in ${location}`).toBeTruthy()
  return id as string
}

export function consentPost(
  env: TestEnv,
  cookie: string,
  body: Record<string, unknown>,
  ip = freshIp()
) {
  return request(
    '/oauth/consent',
    {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip, ...sessionCookieHeader(cookie) },
    },
    { env, json: body }
  )
}

export function tokenPost(env: TestEnv, form: Record<string, string>, ip = freshIp()) {
  return request(
    '/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
      body: new URLSearchParams(form).toString(),
    },
    { env }
  )
}

export function revokePost(env: TestEnv, form: Record<string, string>) {
  return request(
    '/oauth/revoke',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    { env }
  )
}

/**
 * authorize → (continue) → consent approve → code: the browser half, for a signed-in person.
 * Returns the code and everything the exchange needs. `tenantId` picks the organisation.
 */
export async function authorizeAndApprove(
  env: TestEnv,
  cookie: string,
  input: { tenantId: string } & AuthorizeParams
): Promise<{
  code: string
  verifier: string
  redirectUri: string
  clientId: string
  location: URL
}> {
  const { verifier, challenge } = pkcePair()
  const params = validAuthorize(env, { ...input, challenge })
  const start = await browserGet(env, authorizePath(params), cookie)
  expect(start.status, await start.clone().text()).toBe(302)
  let location = start.headers.get('Location') ?? ''
  if (location.startsWith('/consent')) {
    const decided = await consentPost(env, cookie, {
      requestId: requestIdFrom(location),
      approve: true,
      tenantId: input.tenantId,
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    location = ((await decided.json()) as { redirectTo: string }).redirectTo
  }
  const url = new URL(location)
  const code = url.searchParams.get('code')
  expect(code, `no code in ${location}`).toBeTruthy()
  return {
    code: code as string,
    verifier,
    redirectUri: params.redirect_uri as string,
    clientId: params.client_id as string,
    location: url,
  }
}

/** The whole connection: a code exchanged for a token pair. */
export async function connectViaOAuth(
  env: TestEnv,
  cookie: string,
  input: { tenantId: string } & AuthorizeParams
): Promise<{ accessToken: string; refreshToken: string; scope: string; clientId: string }> {
  const { code, verifier, redirectUri, clientId } = await authorizeAndApprove(env, cookie, input)
  const res = await tokenPost(env, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: input.resource ?? `${new URL(env.APP_URL as string).origin}/mcp`,
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const body = (await res.json()) as {
    access_token: string
    refresh_token: string
    scope: string
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
    clientId,
  }
}
