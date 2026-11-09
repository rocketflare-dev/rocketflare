/**
 * Whole public websites served from this Worker on hostnames of their own
 * (`ServerPlugin.publicSites`). On a host a plugin claims, its router answers everything, so
 * `/api/*`, `/auth/*` and `/ws` do not exist there. Elsewhere this is a pass-through, and with no
 * plugin declaring `publicSites` the middleware is a bare `next()`.
 *
 * Why a nested Hono app per plugin rather than `app.route()`: routes cannot be gated on the host.
 * The plugin's router runs as its own dispatch, with the outer context's variables (`db`, `config`,
 * `logger`…) copied across, so a handler reads them exactly as it does on a mount.
 *
 * The cached body is what the router returned, before any outer middleware adds headers, so
 * `securityHeaders` applies `publicSiteCsp` to hits and misses alike.
 *
 * Hits never touch Postgres: `databaseMiddleware` opens a handle per request but neither driver
 * connects until the first query, and `cache.generation` must not run one.
 */
import type { Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppConfig } from '../../config'
import type {
  AnyServerPlugin,
  PublicSiteCsp,
  PublicSiteFormPath,
  PublicSitesDeclaration,
} from '../../plugins/types'
import type { AppContext, AppEnv, AppVariables } from '../types'
import { createRouter } from '../utils/routes/router'
import { MAX_PUBLIC_MOUNT_BODY_BYTES } from './body-limit'
import { deferOrAwait } from './database'
import { errorHandler, notFoundHandler } from './error-handler'
import { PUBLIC_MOUNT_RATE_LIMIT } from './public-mounts'
import { rateLimit } from './rate-limit'
import { publicSiteCsp } from './security-headers'

/** Lowercase DNS labels, no scheme, port or path. The gate and the runtime read the same rule. */
export const PUBLIC_SITE_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** A form's body cap when it declares none: enough for a contact form, not for a file. */
export const DEFAULT_PUBLIC_FORM_BODY_BYTES = 64 * 1024

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A stored entry's `Cache-Control` drives the edge; the router's own value rides beside it. */
const ROUTER_CACHE_CONTROL = 'x-public-site-cache-control'

interface Site {
  id: string
  declaration: PublicSitesDeclaration
  dispatcher: Hono<AppEnv>
}

interface SiteClaims {
  hosts: ReadonlyMap<string, Site>
  /** A plugin's `hosts` returned null or threw: foreign hosts get a 503. */
  dormant: boolean
}

/** How a nested dispatch finds the outer context: no other argument survives `fetch`. */
const parentContexts = new WeakMap<Request, AppContext>()

function dispatcherFor(router: Hono<AppEnv>): Hono<AppEnv> {
  const dispatcher = createRouter()
  dispatcher.onError(errorHandler)
  dispatcher.notFound(notFoundHandler)
  dispatcher.use('*', async (c, next) => {
    const parent = parentContexts.get(c.req.raw)
    if (parent) {
      for (const [key, value] of Object.entries(parent.var)) {
        c.set(key as keyof AppVariables, value as never)
      }
    }
    await next()
  })
  dispatcher.route('/', router)
  return dispatcher
}

function appHostOf(config: AppConfig): string {
  return new URL(config.APP_URL).hostname
}

/** Evaluate every plugin's claim once per config, so a bad one is logged once per isolate. */
function resolveClaims(sites: readonly Site[], c: AppContext, config: AppConfig): SiteClaims {
  const logger = c.get('logger')
  const appHost = appHostOf(config)
  const hosts = new Map<string, Site>()
  let dormant = false
  for (const site of sites) {
    let claimed: readonly string[] | null
    try {
      claimed = site.declaration.hosts(config)
    } catch (err) {
      logger.error({ err, plugin: site.id }, 'public site hosts() threw; plugin is dormant')
      claimed = null
    }
    if (claimed === null) {
      dormant = true
      continue
    }
    for (const host of claimed) {
      const owner = hosts.get(host)
      if (!PUBLIC_SITE_HOST.test(host) || host === appHost || (owner && owner !== site)) {
        logger.error({ plugin: site.id, host }, 'public site host claim ignored')
        continue
      }
      hosts.set(host, site)
    }
  }
  return { hosts, dormant }
}

function declaredCsp(site: Site, c: AppContext, host: string, config: AppConfig): PublicSiteCsp {
  try {
    return site.declaration.csp?.(host, config) ?? {}
  } catch (err) {
    c.get('logger').error({ err, plugin: site.id, host }, 'public site csp() threw')
    return {}
  }
}

function runRouter(c: AppContext, site: Site, request: Request): Promise<Response> {
  parentContexts.set(request, c)
  let ctx: ExecutionContext | undefined
  try {
    ctx = c.executionCtx as ExecutionContext
  } catch {
    ctx = undefined
  }
  return Promise.resolve(site.dispatcher.fetch(request, c.env, ctx))
}

type RateLimit = { max: number; windowSeconds: number } | false

async function throttled(
  c: AppContext,
  name: string,
  limit: RateLimit,
  work: () => Promise<void>
): Promise<void> {
  if (limit === false) return work()
  await rateLimit({ name, max: limit.max, windowSeconds: limit.windowSeconds })(c, work)
}

const methodNotAllowed = (c: AppContext, allow: string) =>
  c.text('Method Not Allowed', 405, { Allow: allow })

async function answerForm(
  c: AppContext,
  site: Site,
  host: string,
  form: PublicSiteFormPath
): Promise<Response> {
  const limit = bodyLimit({
    maxSize: Math.min(
      Math.max(0, form.bodyLimitBytes ?? DEFAULT_PUBLIC_FORM_BODY_BYTES),
      MAX_PUBLIC_MOUNT_BODY_BYTES
    ),
    onError: tooLarge => tooLarge.text('Payload Too Large', 413),
  })
  let response: Response | undefined
  await throttled(
    c,
    `site-form:${host}:${form.path}`,
    form.rateLimit ?? PUBLIC_MOUNT_RATE_LIMIT,
    async () => {
      const refused = await limit(c, async () => {
        response = await runRouter(c, site, c.req.raw)
      })
      if (refused) response = refused
    }
  )
  return response as Response
}

function edgeCache(): Cache | undefined {
  // The DOM lib's `CacheStorage` is the one in scope here and has no `default`; absent under Node.
  return typeof caches === 'undefined'
    ? undefined
    : (caches as unknown as { default: Cache }).default
}

/** A stored page is served to everyone, so the render that fills the cache never sees these. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

function withoutCredentials(headers: Headers): Headers {
  const anonymous = new Headers(headers)
  for (const name of CREDENTIAL_HEADERS) anonymous.delete(name)
  return anonymous
}

/** Does the key separate everything `Vary` names? `Accept-Encoding` is the platform's to handle. */
function varyIsCovered(response: Response, covered: readonly string[]): boolean {
  const vary = response.headers.get('vary')
  if (!vary) return true
  const headers = new Set(covered.map(h => h.toLowerCase()))
  return vary
    .split(',')
    .map(h => h.trim().toLowerCase())
    .every(h => h === '' || h === 'accept-encoding' || headers.has(h))
}

function isStorable(response: Response, coveredVary: readonly string[]): boolean {
  return (
    response.status === 200 &&
    !response.headers.has('set-cookie') &&
    varyIsCovered(response, coveredVary) &&
    !/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') ?? '')
  )
}

function toCacheEntry(response: Response, ttlSeconds: number): Response {
  const entry = new Response(response.body, response)
  const routerValue = entry.headers.get('cache-control')
  if (routerValue) entry.headers.set(ROUTER_CACHE_CONTROL, routerValue)
  entry.headers.set('cache-control', `public, s-maxage=${ttlSeconds}`)
  return entry
}

/** The response as the router gave it. A new object: a matched entry's headers are immutable. */
function fromCacheEntry(entry: Response, head: boolean): Response {
  const headers = new Headers(entry.headers)
  const routerValue = headers.get(ROUTER_CACHE_CONTROL)
  headers.delete(ROUTER_CACHE_CONTROL)
  if (routerValue) headers.set('cache-control', routerValue)
  else headers.delete('cache-control')
  return new Response(head ? null : entry.body, { status: entry.status, headers })
}

/**
 * A cacheable request reaches the router without its query string, so a redirect it answers cannot
 * have kept one. Put it back, or an old link loses its campaign parameters.
 */
function withOriginalQuery(response: Response, search: string): Response {
  const location = response.headers.get('location')
  if (!search || !location || response.status < 300 || response.status > 399) return response
  if (location.includes('?')) return response
  const redirected = new Response(response.body, response)
  redirected.headers.set('location', `${location}${search}`)
  return redirected
}

/** The declared variant as a key suffix. A pathname cannot contain `?`, so it cannot forge one. */
function cacheVariantSuffix(declaration: PublicSitesDeclaration, request: Request): string {
  const variant = declaration.cache?.variant?.(request)
  return variant ? `?v=${encodeURIComponent(variant)}` : ''
}

async function generationOf(c: AppContext, site: Site, config: AppConfig): Promise<string | null> {
  const cache = site.declaration.cache
  if (!cache) return null
  try {
    return await cache.generation(c.env, config)
  } catch (err) {
    c.get('logger').warn({ err, plugin: site.id }, 'public site generation failed; not caching')
    return null
  }
}

async function answerPage(
  c: AppContext,
  site: Site,
  host: string,
  url: URL,
  config: AppConfig
): Promise<Response> {
  const declaration = site.declaration
  const head = c.req.method === 'HEAD'
  const logger = c.get('logger')
  const cache = edgeCache()
  const generation = cache ? await generationOf(c, site, config) : null
  const variantSuffix = generation === null ? '' : cacheVariantSuffix(declaration, c.req.raw)
  const key =
    generation === null
      ? null
      : new Request(
          `https://${host}/${encodeURIComponent(generation)}${url.pathname}${variantSuffix}`
        )

  if (cache && key) {
    const entry = await cache.match(key).catch((err: unknown) => {
      logger.warn({ err, plugin: site.id }, 'public site cache lookup failed')
      return undefined
    })
    if (entry) return fromCacheEntry(entry, head)
  }

  // What gets stored is served to everyone at this path, so it is rendered without the query
  // string or the visitor's credentials: otherwise `?preview=…` or a session cookie could put one
  // visitor's page in front of all of them.
  const request = key
    ? new Request(`${url.origin}${url.pathname}`, {
        method: 'GET',
        headers: withoutCredentials(c.req.raw.headers),
      })
    : c.req.raw

  let response: Response | undefined
  await throttled(c, `site:${host}`, declaration.rateLimit ?? PUBLIC_MOUNT_RATE_LIMIT, async () => {
    response = await runRouter(c, site, request)
  })
  const answered = key
    ? withOriginalQuery(response as Response, url.search)
    : (response as Response)

  const coveredVary = variantSuffix ? (declaration.cache?.variantHeaders ?? []) : []
  if (cache && key && declaration.cache && isStorable(answered, coveredVary)) {
    const { ttlSeconds } = declaration.cache
    const ttl = typeof ttlSeconds === 'function' ? ttlSeconds(url.pathname) : ttlSeconds
    const entry = toCacheEntry(answered.clone(), ttl)
    await deferOrAwait(c, () =>
      cache.put(key, entry).catch((err: unknown) => {
        logger.warn({ err, plugin: site.id }, 'public site cache put failed')
      })
    )
  }
  return key && head ? new Response(null, answered) : answered
}

export function publicSitesMiddleware(
  plugins: readonly AnyServerPlugin[]
): MiddlewareHandler<AppEnv> {
  const sites: Site[] = plugins.flatMap(plugin =>
    plugin.publicSites
      ? [
          {
            id: plugin.shared.id,
            declaration: plugin.publicSites,
            dispatcher: dispatcherFor(plugin.publicSites.router),
          },
        ]
      : []
  )
  if (sites.length === 0) return (_c, next) => next()

  // `loadConfig` caches per env, so this is once per isolate rather than once per request.
  const claimsByConfig = new WeakMap<AppConfig, SiteClaims>()

  return async (c, next) => {
    const config = c.get('config')
    let claims = claimsByConfig.get(config)
    if (!claims) {
      claims = resolveClaims(sites, c, config)
      claimsByConfig.set(config, claims)
    }

    // The URL's own host, already lowercase and without a port. Never a forwarded header.
    const url = new URL(c.req.url)
    const host = url.hostname
    const site = claims.hosts.get(host)
    if (!site) {
      if (claims.dormant && host !== appHostOf(config) && !LOOPBACK_HOSTS.has(host)) {
        return c.text('Service Unavailable', 503, { 'Cache-Control': 'no-store' })
      }
      return next()
    }

    c.set(
      'publicSiteCsp',
      publicSiteCsp(new URL(c.req.url).origin, declaredCsp(site, c, host, config))
    )

    // Plain text, not the API envelope: this host has no API, and a visitor's browser reads it.
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD') return answerPage(c, site, host, url, config)
    const form = site.declaration.forms?.find(f => f.path === url.pathname)
    if (method === 'POST' && form) return answerForm(c, site, host, form)
    return methodNotAllowed(c, form ? 'GET, HEAD, POST' : 'GET, HEAD')
  }
}
