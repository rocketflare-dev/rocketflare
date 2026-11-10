// @vitest-isolate
/**
 * Public site hosts, driven through the real app with a fixture plugin added to the server barrel.
 * The Cache API does not exist under Node, so `caches.default` is an in-memory stub. `openDatabase`
 * is wrapped to count any use of the handle: that is what proves a cache hit costs no database work.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configMiddleware } from '@/api/middleware/config'
import { publicSitesMiddleware } from '@/api/middleware/public-sites'
import { requestIdMiddleware, requestLogger } from '@/api/middleware/request-logger'
import { publicSiteCsp } from '@/api/middleware/security-headers'
import type { AppEnv } from '@/api/types'
import type { AnyServerPlugin, PublicSitesDeclaration } from '@/plugins/types'
import { request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const state = vi.hoisted(() => ({
  hosts: ['www.example.test'] as readonly string[] | null,
  generation: 'g1' as string | null,
  routerCalls: 0,
  queries: [] as (string | undefined)[],
  dbTouches: 0,
}))

vi.mock('@/db/client', async importOriginal => {
  const real = await importOriginal<typeof import('@/db/client')>()
  return {
    ...real,
    openDatabase: (...args: Parameters<typeof real.openDatabase>) => {
      const handle = real.openDatabase(...args)
      const db = new Proxy(handle.db, {
        get(target, prop, receiver) {
          state.dbTouches += 1
          return Reflect.get(target, prop, receiver)
        },
      })
      return { ...handle, db }
    },
  }
})

vi.mock('@/plugins/server', async importOriginal => {
  const real = await importOriginal<typeof import('@/plugins/server')>()
  const { Hono: HonoApp } = await import('hono')
  const { sql: rawSql } = await import('drizzle-orm')
  const router = new HonoApp<AppEnv>()
  router.use('*', async (c, next) => {
    state.routerCalls += 1
    state.queries.push(new URL(c.req.url).search)
    await next()
  })
  router.get('/about', c => c.html('<h1>About</h1>'))
  router.get('/bare/page', c => c.html('<h1>Bare</h1>'))
  router.get('/cacheable-header', c =>
    c.text('browser-cached', 200, { 'Cache-Control': 'max-age=60' })
  )
  router.get('/long', c => c.text('long'))
  router.get('/embeds', c =>
    c.html('<h1>Embed</h1>', 200, {
      'x-public-site-page-csp': JSON.stringify({
        scriptSrc: ['https://widget.example', "'unsafe-inline'"],
        frameSrc: ['https://widget.example'],
      }),
    })
  )
  router.get('/negotiated', c => c.text(`for ${c.req.header('accept')}`, 200, { Vary: 'Accept' }))
  router.get('/credentials', c =>
    c.text(
      `${c.req.header('cookie') ?? 'no cookie'}, ${c.req.header('authorization') ?? 'no auth'}`
    )
  )
  router.get('/vary-language', c => c.text('language', 200, { Vary: 'Accept-Language' }))
  router.get('/vary-accept-no-variant', c => c.text('accept', 200, { Vary: 'Accept' }))
  router.get('/vary-all', c => c.text('all', 200, { Vary: '*' }))
  router.get('/vary-encoding', c => c.text('encoding', 200, { Vary: 'Accept-Encoding' }))
  router.get('/moved', c => c.redirect('/about', 301))
  router.get('/moved-with-query', c => c.redirect('/about?keep=1', 301))
  router.get('/gone', c => c.text('gone', 410))
  router.get('/cookie', c => c.text('cookie', 200, { 'Set-Cookie': 'a=1' }))
  router.get('/private', c => c.text('private', 200, { 'Cache-Control': 'private' }))
  router.get('/from-db', async c => {
    await c.get('db').execute(rawSql`select 1`)
    return c.text('from-db')
  })
  router.post('/forms/contact', async c => c.text(`got ${(await c.req.text()).length}`))
  router.post('/forms/limited', c => c.text('limited'))
  const fixture = {
    shared: { id: 'site-fixture' },
    publicSites: {
      hosts: () => state.hosts,
      router,
      // A path can carry less than the rest of the host: `/bare/*` gets no declared source.
      csp: (host: string, _config: unknown, pathname: string) =>
        host === 'www.example.test' && !pathname.startsWith('/bare/')
          ? { scriptSrc: ['https://plausible.io'] }
          : {},
      forms: [
        { path: '/forms/contact', bodyLimitBytes: 16 },
        { path: '/forms/limited', rateLimit: { max: 1, windowSeconds: 60 } },
      ],
      cache: {
        generation: async () => state.generation,
        ttlSeconds: (path: string) => (path.startsWith('/long') ? 9000 : 300),
        variant: (request: Request) =>
          new URL(request.url).pathname === '/negotiated'
            ? (request.headers.get('accept') ?? 'none')
            : null,
        variantHeaders: ['Accept'],
      },
    } satisfies PublicSitesDeclaration,
  } as unknown as AnyServerPlugin
  return { ...real, serverPlugins: [...real.serverPlugins, fixture] }
})

/** `caches.default` under Node: a plain map from URL to the stored response. */
class MemoryCache {
  readonly store = new Map<string, Response>()
  async match(key: Request) {
    return this.store.get(key.url)?.clone()
  }
  async put(key: Request, response: Response) {
    this.store.set(key.url, new Response(await response.arrayBuffer(), response))
  }
}

const SITE = 'http://www.example.test'
const SITE_ASSETS = `${SITE}/site-assets/`
const STRICT_WITH_SCRIPT =
  `default-src 'none'; script-src ${SITE_ASSETS} https://plausible.io; style-src ${SITE_ASSETS}; ` +
  "img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'"

let cache: MemoryCache

beforeEach(() => {
  cache = new MemoryCache()
  vi.stubGlobal('caches', { default: cache })
  Object.assign(state, {
    hosts: ['www.example.test'],
    generation: 'g1',
    routerCalls: 0,
    queries: [],
    dbTouches: 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the public CSP on the wire', () => {
  it('names the site-assets path with the port, on a miss and on a cache hit', async () => {
    const ported = 'http://www.example.test:8788'
    const expected =
      `default-src 'none'; script-src ${ported}/site-assets/ https://plausible.io; ` +
      `style-src ${ported}/site-assets/; img-src 'self'; font-src 'self'; connect-src 'none'; ` +
      "frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    const miss = await request(`${ported}/about`)
    expect(miss.headers.get('content-security-policy')).toBe(expected)
    const hit = await request(`${ported}/about`)
    expect(state.routerCalls).toBe(1)
    expect(hit.headers.get('content-security-policy')).toBe(expected)
  })
})

describe('a matching host', () => {
  it('answers from the plugin, with the public CSP', async () => {
    const res = await request(`${SITE}/about`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>About</h1>')
    expect(res.headers.get('content-security-policy')).toBe(STRICT_WITH_SCRIPT)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it("gives the declared CSP the request's pathname", async () => {
    const res = await request(`${SITE}/bare/page`)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'none';")
    expect(csp).not.toContain('https://plausible.io')
  })

  it('never reaches core on /api/*, /auth/* or /ws', async () => {
    for (const path of ['/api/me', '/api/health', '/auth/methods', '/ws']) {
      const res = await request(`${SITE}${path}`)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toMatchObject({ code: 'not_found' })
    }
    expect(state.routerCalls).toBe(4)
  })

  it('matches the URL host case-insensitively and ignores its port', async () => {
    const res = await request('http://WWW.Example.Test:8443/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>About</h1>')
  })

  it('does not trust a forwarded host', async () => {
    const res = await request('http://localhost:3001/api/health', {
      headers: { 'X-Forwarded-Host': 'www.example.test', Host: 'www.example.test' },
    })
    expect(res.status).toBe(200)
    expect(state.routerCalls).toBe(0)
  })
})

describe('methods', () => {
  it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s with a 405', async method => {
    const res = await request(`${SITE}/about`, { method })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    expect(res.headers.get('content-security-policy')).toBe(STRICT_WITH_SCRIPT)
    expect(state.routerCalls).toBe(0)
  })

  it('leaves OPTIONS to the CORS step, which runs first and never reaches the router', async () => {
    const res = await request(`${SITE}/about`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(state.routerCalls).toBe(0)
  })

  it('refuses a POST to a path that is not a declared form', async () => {
    const res = await request(`${SITE}/about`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(405)
    expect(state.routerCalls).toBe(0)
  })

  it('names POST in Allow on a form path', async () => {
    const res = await request(`${SITE}/forms/contact`, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD, POST')
  })
})

describe('form posts', () => {
  it('reaches the router and bypasses the cache', async () => {
    const env = createTestEnv()
    const send = () => request(`${SITE}/forms/contact`, { method: 'POST', body: 'hello' }, { env })
    expect(await (await send()).text()).toBe('got 5')
    expect(await (await send()).text()).toBe('got 5')
    expect(state.routerCalls).toBe(2)
    expect(cache.store.size).toBe(0)
  })

  it('enforces its own body cap, with or without a Content-Length', async () => {
    const big = 'x'.repeat(17)
    const chunked = await request(`${SITE}/forms/contact`, { method: 'POST', body: big })
    expect(chunked.status).toBe(413)
    const declared = await request(`${SITE}/forms/contact`, {
      method: 'POST',
      body: big,
      headers: { 'Content-Length': '17' },
    })
    expect(declared.status).toBe(413)
    expect(state.routerCalls).toBe(0)
    const exact = await request(`${SITE}/forms/contact`, {
      method: 'POST',
      body: 'x'.repeat(16),
    })
    expect(exact.status).toBe(200)
  })

  it('has its own rate-limit bucket', async () => {
    const env = createTestEnv()
    const send = () => request(`${SITE}/forms/limited`, { method: 'POST', body: 'x' }, { env })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(429)
    expect((await request(`${SITE}/about`, {}, { env })).status).toBe(200)
  })
})

describe('the cache', () => {
  it('answers a hit with no router and no database, and carries the CSP', async () => {
    const env = createTestEnv()
    const first = await request(`${SITE}/about`, {}, { env })
    expect(await first.text()).toBe('<h1>About</h1>')
    expect(state.routerCalls).toBe(1)
    expect(state.dbTouches).toBe(0)

    const second = await request(`${SITE}/about`, {}, { env })
    expect(await second.text()).toBe('<h1>About</h1>')
    expect(state.routerCalls).toBe(1)
    expect(state.dbTouches).toBe(0)
    expect(second.headers.get('content-security-policy')).toBe(STRICT_WITH_SCRIPT)
    expect(second.headers.get('x-content-type-options')).toBe('nosniff')
    expect(second.headers.get('content-type')).toBe(first.headers.get('content-type'))
  })

  it('counts database use, so a zero above means something', async () => {
    state.generation = null
    const res = await request(`${SITE}/from-db`)
    expect(res.status).toBe(200)
    expect(state.dbTouches).toBeGreaterThan(0)
  })

  it('stores under <host>/<generation>/<path> with the configured TTL', async () => {
    await request(`${SITE}/about`)
    expect([...cache.store.keys()]).toEqual(['https://www.example.test/g1/about'])
    const entry = cache.store.get('https://www.example.test/g1/about')
    expect(entry?.headers.get('cache-control')).toBe('public, s-maxage=300')
    expect(entry?.headers.get('content-security-policy')).toBeNull()
  })

  it("serves the router's own Cache-Control on hits and misses, not the edge's", async () => {
    const env = createTestEnv()
    const miss = await request(`${SITE}/cacheable-header`, {}, { env })
    const hit = await request(`${SITE}/cacheable-header`, {}, { env })
    expect(state.routerCalls).toBe(1)
    expect(miss.headers.get('cache-control')).toBe('max-age=60')
    expect(hit.headers.get('cache-control')).toBe('max-age=60')
    expect((await request(`${SITE}/about`, {}, { env })).headers.get('cache-control')).toBeNull()
    expect((await request(`${SITE}/about`, {}, { env })).headers.get('cache-control')).toBeNull()
  })

  it('shares one entry across query strings, rendered without them', async () => {
    const env = createTestEnv()
    await request(`${SITE}/about?utm=1`, {}, { env })
    const second = await request(`${SITE}/about?preview=secret`, {}, { env })
    expect(await second.text()).toBe('<h1>About</h1>')
    expect(state.routerCalls).toBe(1)
    expect(state.queries).toEqual([''])
    expect(cache.store.size).toBe(1)
  })

  it('stores one entry per declared variant, and the router still sees the header', async () => {
    const env = createTestEnv()
    const avif = { headers: { accept: 'image/avif' } }
    const webp = { headers: { accept: 'image/webp' } }
    await request(`${SITE}/negotiated`, avif, { env })
    await request(`${SITE}/negotiated`, webp, { env })
    const hit = await request(`${SITE}/negotiated`, avif, { env })
    expect(await hit.text()).toBe('for image/avif')
    expect(state.routerCalls).toBe(2)
    expect(cache.store.size).toBe(2)
  })

  it("renders a cacheable page without the visitor's credentials", async () => {
    const env = createTestEnv()
    const signedIn = { headers: { cookie: 'session=first', authorization: 'Bearer first' } }
    const first = await request(`${SITE}/credentials`, signedIn, { env })
    expect(await first.text()).toBe('no cookie, no auth')
    const second = await request(`${SITE}/credentials`, {}, { env })
    expect(await second.text()).toBe('no cookie, no auth')
    expect(state.routerCalls).toBe(1)
  })

  it('still shows the router the credentials when the page is not cached', async () => {
    state.generation = null
    const res = await request(`${SITE}/credentials`, { headers: { cookie: 'session=first' } })
    expect(await res.text()).toBe('session=first, no auth')
  })

  it.each(['/vary-language', '/vary-accept-no-variant', '/vary-all'])(
    'does not store %s, whose Vary the key does not separate',
    async path => {
      const env = createTestEnv()
      await request(`${SITE}${path}`, {}, { env })
      await request(`${SITE}${path}`, {}, { env })
      expect(state.routerCalls).toBe(2)
      expect(cache.store.size).toBe(0)
    }
  )

  it('stores a response that varies only on Accept-Encoding', async () => {
    const env = createTestEnv()
    await request(`${SITE}/vary-encoding`, {}, { env })
    await request(`${SITE}/vary-encoding`, {}, { env })
    expect(state.routerCalls).toBe(1)
  })

  it('does not vary a path whose variant is null', async () => {
    const env = createTestEnv()
    await request(`${SITE}/about`, { headers: { accept: 'a' } }, { env })
    await request(`${SITE}/about`, { headers: { accept: 'b' } }, { env })
    expect(state.routerCalls).toBe(1)
  })

  it('takes the time to live from the pathname when it is a function', async () => {
    const env = createTestEnv()
    await request(`${SITE}/long`, {}, { env })
    await request(`${SITE}/about`, {}, { env })
    const controls = [...cache.store.values()].map(r => r.headers.get('cache-control'))
    expect(controls).toEqual(['public, s-maxage=9000', 'public, s-maxage=300'])
  })

  it('keeps the query string on a redirect, which is never stored', async () => {
    const env = createTestEnv()
    const moved = await request(`${SITE}/moved?utm=1`, {}, { env })
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe('/about?utm=1')
    expect(cache.store.size).toBe(0)
    const own = await request(`${SITE}/moved-with-query?utm=1`, {}, { env })
    expect(own.headers.get('location')).toBe('/about?keep=1')
  })

  it('moves to a new entry when the generation changes', async () => {
    const env = createTestEnv()
    await request(`${SITE}/about`, {}, { env })
    state.generation = 'g2'
    await request(`${SITE}/about`, {}, { env })
    expect(state.routerCalls).toBe(2)
    expect(cache.store.size).toBe(2)
  })

  it('answers HEAD with no body, from the GET entry and into it', async () => {
    const env = createTestEnv()
    const miss = await request(`${SITE}/about`, { method: 'HEAD' }, { env })
    expect(miss.status).toBe(200)
    expect(await miss.text()).toBe('')
    expect(state.routerCalls).toBe(1)
    expect(cache.store.size).toBe(1)

    const get = await request(`${SITE}/about`, {}, { env })
    expect(await get.text()).toBe('<h1>About</h1>')
    expect(state.routerCalls).toBe(1)

    const hit = await request(`${SITE}/about`, { method: 'HEAD' }, { env })
    expect(hit.status).toBe(200)
    expect(await hit.text()).toBe('')
    expect(hit.headers.get('content-security-policy')).toBe(STRICT_WITH_SCRIPT)
    expect(state.routerCalls).toBe(1)
  })

  it('does not store a non-200, a Set-Cookie or a private response', async () => {
    const env = createTestEnv()
    for (const path of ['/gone', '/nope', '/cookie', '/private']) {
      await request(`${SITE}${path}`, {}, { env })
      await request(`${SITE}${path}`, {}, { env })
    }
    expect(state.routerCalls).toBe(8)
    expect(cache.store.size).toBe(0)
  })

  it('does not cache when the generation is null, and the router sees the query', async () => {
    state.generation = null
    const env = createTestEnv()
    await request(`${SITE}/about?x=1`, {}, { env })
    await request(`${SITE}/about?x=1`, {}, { env })
    expect(state.routerCalls).toBe(2)
    expect(state.queries).toEqual(['?x=1', '?x=1'])
    expect(cache.store.size).toBe(0)
  })
})

describe('a page that adds to the CSP for itself', () => {
  it('applies on a miss and a hit, drops weakening sources and hides the header', async () => {
    const env = createTestEnv()
    const check = async (response: Response) => {
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp).toContain(`script-src ${SITE_ASSETS} https://plausible.io https://widget.example`)
      expect(csp).not.toContain("'unsafe-inline'")
      expect(csp).toContain('frame-src https://widget.example')
      expect(response.headers.has('x-public-site-page-csp')).toBe(false)
    }
    await check(await request(`${SITE}/embeds`, {}, { env }))
    await check(await request(`${SITE}/embeds`, {}, { env }))
    expect(state.routerCalls).toBe(1)
    const other = await request(`${SITE}/about`, {}, { env })
    expect(other.headers.get('content-security-policy')).toBe(STRICT_WITH_SCRIPT)
  })

  it('pins a form-action path to the request origin', () => {
    const csp = publicSiteCsp('https://www.example.test', { formAction: ['/submit'] })
    expect(csp).toContain('form-action https://www.example.test/submit;')
  })

  it('pins a connect-src path to the request origin', () => {
    const csp = publicSiteCsp('https://www.example.test', {
      connectSrc: ['/forms/submit', 'https://api.example'],
    })
    expect(csp).toContain('connect-src https://www.example.test/forms/submit https://api.example;')
  })
})

describe('page requests', () => {
  it('are never rate limited, on a hit or a miss', async () => {
    const env = createTestEnv()
    for (let i = 0; i < 200; i++) {
      expect((await request(`${SITE}/gone`, {}, { env })).status).toBe(410)
    }
    expect(state.routerCalls).toBe(200)
  })
})

describe('HSTS', () => {
  const deployed = () => createTestEnv({ APP_ENV: 'staging' })

  it('never speaks for the subdomains of a public site', async () => {
    const res = await request(`${SITE}/about`, {}, { env: deployed() })
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
  })

  it('does so on the app host', async () => {
    const res = await request('http://localhost:3001/health', {}, { env: deployed() })
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
  })

  it('leaves a claimed host out of it while the plugin is dormant', async () => {
    state.hosts = null
    const res = await request(`${SITE}/about`, {}, { env: deployed() })
    expect(res.status).toBe(503)
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
  })
})

describe('dormant', () => {
  beforeEach(() => {
    state.hosts = null
  })

  it('answers foreign hosts with a plain, uncached 503', async () => {
    const res = await request(`${SITE}/about`)
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('Service Unavailable')
    expect(state.routerCalls).toBe(0)
    expect(cache.store.size).toBe(0)
  })

  it('leaves the app host and loopback alone', async () => {
    const env = createTestEnv({ APP_URL: 'https://admin.example.test' })
    const app = await request('https://admin.example.test/api/health', {}, { env })
    expect(app.status).toBe(200)
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001']) {
      expect((await request(`${origin}/api/health`)).status, origin).toBe(200)
    }
  })

  it('leaves www.localhost dormant, since it is not loopback', async () => {
    expect((await request('http://www.localhost:3001/about')).status).toBe(503)
  })
})

describe('claims', () => {
  const appWith = (declarations: Record<string, Partial<PublicSitesDeclaration>>) => {
    const plugins = Object.entries(declarations).map(([id, declaration]) => {
      const router = new Hono<AppEnv>()
      router.get('/', c => c.text(id))
      return {
        shared: { id },
        publicSites: { hosts: () => [], router, ...declaration },
      } as unknown as AnyServerPlugin
    })
    const app = new Hono<AppEnv>()
    app.use('*', requestIdMiddleware, requestLogger, configMiddleware)
    app.use('*', publicSitesMiddleware(plugins))
    app.get('*', c => c.text('core'))
    return app
  }

  it('is a pass-through when no plugin declares publicSites', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', requestIdMiddleware, requestLogger, configMiddleware)
    app.use('*', publicSitesMiddleware([{ shared: { id: 'plain' } } as unknown as AnyServerPlugin]))
    app.get('*', c => c.text('core'))
    const res = await request(`${SITE}/about`, {}, { app })
    expect(await res.text()).toBe('core')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('lets the first plugin keep a host two plugins claim', async () => {
    const app = appWith({
      first: { hosts: () => ['www.example.test'] },
      second: { hosts: () => ['www.example.test'] },
    })
    expect(await (await request(`${SITE}/`, {}, { app })).text()).toBe('first')
  })

  it('ignores a claim on the app host or a malformed one', async () => {
    const app = appWith({
      own: { hosts: () => ['localhost', 'WWW.example.test', 'www.example.test'] },
    })
    expect(await (await request('http://localhost:3001/', {}, { app })).text()).toBe('core')
    expect(await (await request(`${SITE}/`, {}, { app })).text()).toBe('own')
  })

  it('treats a throwing hosts() as dormant', async () => {
    const app = appWith({
      broken: {
        hosts: () => {
          throw new Error('bad config')
        },
      },
    })
    expect((await request(`${SITE}/`, {}, { app })).status).toBe(503)
    expect(await (await request('http://localhost:3001/', {}, { app })).text()).toBe('core')
  })

  it('still serves a live plugin when another is dormant', async () => {
    const app = appWith({
      dormant: { hosts: () => null },
      live: { hosts: () => ['www.example.test'] },
    })
    expect(await (await request(`${SITE}/`, {}, { app })).text()).toBe('live')
    expect((await request('http://other.example.test/', {}, { app })).status).toBe(503)
  })

  it('leaves other hosts to core when nothing is dormant', async () => {
    const app = appWith({ live: { hosts: () => ['www.example.test'] } })
    expect(await (await request('http://other.example.test/', {}, { app })).text()).toBe('core')
  })
})

describe('publicSiteCsp', () => {
  const origin = 'https://www.example.com'
  const assets = `${origin}/site-assets/`

  it('is strict by default', () => {
    expect(publicSiteCsp(origin)).toBe(
      `default-src 'none'; script-src 'none'; style-src ${assets}; img-src 'self'; font-src 'self'; ` +
        "connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'"
    )
  })

  it('names the site-assets path on the origin it was given, port included', () => {
    const csp = publicSiteCsp('http://www.localhost:3001', { scriptSrc: ['https://a.example'] })
    expect(csp).toContain(
      'script-src http://www.localhost:3001/site-assets/ https://a.example; style-src http://www.localhost:3001/site-assets/;'
    )
    expect(csp).not.toMatch(/(script|style)-src 'self'/)
  })

  it('adds the declared sources, with the site-assets path for scripts', () => {
    const csp = publicSiteCsp(origin, {
      scriptSrc: ['https://plausible.io'],
      frameSrc: ['https://www.youtube.com'],
      imgSrc: ['https://img.example'],
      connectSrc: ['https://api.example'],
      formAction: ["'self'"],
    })
    expect(csp).toContain(`script-src ${assets} https://plausible.io;`)
    expect(csp).toContain('frame-src https://www.youtube.com;')
    expect(csp).toContain("img-src 'self' https://img.example;")
    expect(csp).toContain('connect-src https://api.example;')
    expect(csp).toContain("form-action 'self';")
  })

  it('drops a forbidden source at runtime', () => {
    expect(
      publicSiteCsp(origin, {
        scriptSrc: ["'unsafe-inline'", '*', 'https://ok.example'],
        imgSrc: ['data:'],
      })
    ).toContain(`script-src ${assets} https://ok.example;`)
    expect(publicSiteCsp(origin, { scriptSrc: ["'unsafe-inline'"] })).toContain(
      "script-src 'none';"
    )
    expect(publicSiteCsp(origin, { imgSrc: ['data:'] })).toContain("img-src 'self';")
  })

  it('drops at runtime a script source that reaches the admin bundle', () => {
    for (const source of ["'self'", 'https:', origin, `${origin}/assets/`]) {
      expect(publicSiteCsp(origin, { scriptSrc: [source] }), source).toContain("script-src 'none';")
    }
  })
})
