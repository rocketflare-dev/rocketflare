/**
 * OAuth clients identified by a Client ID Metadata Document: the client's `client_id` is an https
 * URL, and the JSON document at that URL says what the client is called and where it may be
 * redirected. There is no registration — fetching the document IS how a client becomes known — so
 * this file is the authorization server's whole client model.
 *
 * The fetch is a request the server makes to a URL an anonymous party chose, so it is guarded as
 * one: https on the default port only; no IP literal, no `localhost`, no `.local` / `.internal` /
 * `.localhost`, no single-label host (the names that resolve inside a network rather than on the
 * internet); redirects refused (a public URL that 30x's to a private one would undo all of that);
 * ten seconds; at most 5 KB, counted while streaming so a huge body is never buffered; a JSON
 * content type; and the document's own `client_id` must equal the URL it came from. A Worker
 * cannot resolve DNS itself, so a public name that resolves to a private address is not caught
 * here — the platform's egress does not reach private networks, which is the layer that holds.
 *
 * The document is cached in `oauth_clients` and refetched once it is a day old. The cache is a
 * cache: a failed refetch is a failed authorization, never a silent fall-back to stale redirect
 * URIs.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../../../db/client'
import { type OAuthClientRow, oauthClients } from '../../../db/schema'

export const CIMD_MAX_BYTES = 5 * 1024
export const CIMD_TIMEOUT_MS = 10_000
export const CIMD_REFRESH_MS = 24 * 60 * 60 * 1000

/**
 * What the error page says about ANY document that was fetched and could not be used. One
 * sentence for every outcome: the fetch goes to a URL an anonymous party chose, and a page that
 * told a refused redirect from a 404 from a timeout would report on whatever that URL reaches.
 */
export const CIMD_UNUSABLE = 'The client metadata document could not be used'

/** The page for a `redirect_uri` the client's document does not register. */
export const REDIRECT_NOT_REGISTERED =
  'redirect_uri is not one the client registered in its metadata document'

/**
 * Why a client could not be accepted. `description` is shown on the error page, never
 * redirected; `reason`, when set, is the specific cause, for the server log only.
 */
export class OAuthClientError extends Error {
  constructor(
    readonly description: string,
    readonly reason?: string
  ) {
    super(reason ?? description)
    this.name = 'OAuthClientError'
  }
}

/** A fetched document that cannot be used: the uniform page, the specific `reason` logged. */
function unusable(reason: string): OAuthClientError {
  return new OAuthClientError(CIMD_UNUSABLE, reason)
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.localdomain', '.home.arpa']

/** A hostname that names something on the internet, not inside a network or this machine. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.startsWith('[') || host.includes(':')) return false // IPv6 literal
  if (IPV4.test(host)) return false
  // `0x7f.1`, `2130706433` and friends: an all-numeric or hex label is an address, not a name.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return false
  if (host === 'localhost' || !host.includes('.')) return false
  return !PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/** The `client_id` as a URL this server will fetch, or null. */
export function clientIdUrl(value: string | undefined): URL | null {
  if (!value || value.length > 2048) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port !== '') return null
  if (url.username || url.password || url.hash) return null
  // The spec requires a path: the document is a resource, not a site's root.
  if (url.pathname === '/' || url.pathname === '') return null
  if (!isPublicHostname(url.hostname)) return null
  // The URL must be exactly what was sent — no normalisation the client did not see.
  if (url.toString() !== value) return null
  return url
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** `http://127.0.0.1|localhost|[::1]:<port>/…` — a client on the person's own computer. */
export function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** A redirect URI a document may register: https, or http on loopback. Never a fragment. */
function registrableRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.hash) return false
    return url.protocol === 'https:' || isLoopbackRedirect(value)
  } catch {
    return false
  }
}

export const cimdDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
  logo_uri: z.string().url().max(2048).optional(),
  client_uri: z.string().url().max(2048).optional(),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).max(20).optional(),
  grant_types: z.array(z.string()).max(20).optional(),
  response_types: z.array(z.string()).max(20).optional(),
})
export type CimdDocument = z.infer<typeof cimdDocumentSchema>

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/** Read at most `max` bytes of `body`; null when it is longer. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

/**
 * Whether the client can talk to a token endpoint that authenticates nobody. That is true when its
 * preferred method is absent or `none`, and also when it prefers another method but lists `none`
 * among the ones it supports. ChatGPT's document does exactly that: it prefers `private_key_jwt`
 * and lists `none`. Our metadata advertises `none` alone, so such a client falls back to it, and we
 * never accept a client credential. A client that can authenticate only with a secret or a key is
 * refused.
 */
export function canActAsPublicClient(doc: {
  token_endpoint_auth_method?: string
  token_endpoint_auth_methods_supported?: readonly string[]
}): boolean {
  const preferred = doc.token_endpoint_auth_method
  if (!preferred || preferred === 'none') return true
  return doc.token_endpoint_auth_methods_supported?.includes('none') ?? false
}

/**
 * Fetch and validate the document at `url`. `fetcher` defaults to the global `fetch`, read at
 * call time (tests replace it). Every refusal is `CIMD_UNUSABLE`, its cause in `reason`.
 */
export async function fetchClientDocument(
  url: URL,
  fetcher: Fetcher = (input, init) => globalThis.fetch(input, init)
): Promise<CimdDocument> {
  let res: Response
  try {
    res = await fetcher(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    })
  } catch {
    throw unusable('the fetch failed or timed out')
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {})
    throw unusable(
      res.status >= 300 && res.status < 400
        ? 'it redirects, which is not allowed'
        : `it answered ${res.status}`
    )
  }
  const type = (res.headers.get('Content-Type') ?? '').toLowerCase()
  if (!/^application\/([a-z0-9.+-]*\+)?json\b/.test(type)) {
    await res.body?.cancel().catch(() => {})
    throw unusable('its content type is not JSON')
  }
  const text = await readCapped(res.body, CIMD_MAX_BYTES)
  if (text === null) throw unusable('it is too large')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw unusable('it is not valid JSON')
  }
  const parsed = cimdDocumentSchema.safeParse(json)
  if (!parsed.success) throw unusable('it is malformed')
  const doc = parsed.data
  if (doc.client_id !== url.toString()) {
    throw unusable('it names a different client_id')
  }
  if (!canActAsPublicClient(doc)) {
    throw unusable('only public clients (token_endpoint_auth_method "none") are supported')
  }
  if (doc.grant_types && !doc.grant_types.includes('authorization_code')) {
    throw unusable('the client does not use the authorization_code grant')
  }
  if (doc.response_types && !doc.response_types.includes('code')) {
    throw unusable('the client does not use the code response type')
  }
  if (!doc.redirect_uris.every(registrableRedirect)) {
    throw unusable('it registers a redirect URI that is not allowed')
  }
  return doc
}

/**
 * The client behind `clientId`, from the cache when it is under a day old, else freshly fetched
 * (and the cache rewritten). Throws `OAuthClientError` for anything that is not a usable client.
 * With `forRedirect`, a freshly fetched document that does not register that redirect URI is
 * refused BEFORE it is cached, so a request that cannot go on leaves no row behind.
 */
export async function resolveOAuthClient(
  db: Database,
  clientId: string | undefined,
  options: { now?: Date; fetcher?: Fetcher; forRedirect?: { uri: string | undefined } } = {}
): Promise<OAuthClientRow> {
  const now = options.now ?? new Date()
  const url = clientIdUrl(clientId)
  if (!url) {
    throw new OAuthClientError(
      'client_id must be the https URL of a client metadata document on a public host'
    )
  }
  const [cached] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, url.toString()))
  if (cached && now.getTime() - cached.fetchedAt.getTime() < CIMD_REFRESH_MS) return cached

  const doc = await fetchClientDocument(url, options.fetcher)
  if (
    options.forRedirect &&
    !redirectUriAllowed({ redirectUris: doc.redirect_uris }, options.forRedirect.uri)
  ) {
    throw new OAuthClientError(REDIRECT_NOT_REGISTERED)
  }
  const values = {
    clientName: doc.client_name ?? url.hostname,
    redirectUris: doc.redirect_uris,
    logoUri: doc.logo_uri?.startsWith('https://') ? doc.logo_uri : null,
    clientUri: doc.client_uri ?? null,
    fetchedAt: now,
  }
  const [row] = await db
    .insert(oauthClients)
    .values({ clientId: url.toString(), ...values })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
    .returning()
  if (!row) throw new Error('oauth_clients: upsert returned no row')
  return row
}

/**
 * Is `redirectUri` one the client registered? Exact match — except a loopback one, where the port
 * is the client's to choose at run time (RFC 8252 §7.3): scheme, host and path must still match.
 */
export function redirectUriAllowed(
  client: Pick<OAuthClientRow, 'redirectUris'>,
  redirectUri: string | undefined
): boolean {
  if (!redirectUri) return false
  if (client.redirectUris.includes(redirectUri)) return true
  if (!isLoopbackRedirect(redirectUri)) return false
  const asked = new URL(redirectUri)
  if (asked.hash || asked.username || asked.password) return false
  return client.redirectUris.some(registered => {
    if (!isLoopbackRedirect(registered)) return false
    const r = new URL(registered)
    return (
      r.hostname === asked.hostname && r.pathname === asked.pathname && r.search === asked.search
    )
  })
}

/** The host the `client_id` document came from — the one fact about the client that was checked. */
export function verifiedClientHost(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}
